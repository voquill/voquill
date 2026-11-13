//! Streams a file from disk to a resumable upload session (the Google Cloud
//! Storage protocol: chunked `PUT`s with `Content-Range`, `308` + `Range`
//! replies, and `bytes */total` status queries). One call makes one pass:
//! it asks the session how much it already has, then sends the rest. Retry
//! policy and what to do with each outcome are up to the caller.

use std::collections::HashMap;
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::blocking::{Body, Client, Response};

pub const EVT_RESUMABLE_UPLOAD_PROGRESS: &str = "resumable_upload_progress";

/// A multiple of 256 KiB, as the protocol requires for every chunk but the last.
pub const UPLOAD_CHUNK_BYTES: u64 = 8 * 1024 * 1024;
const PROGRESS_STEP_BYTES: u64 = 512 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UploadHeader {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResumableUploadArgs {
    /// Caller-chosen id for progress events and cancellation.
    pub upload_id: String,
    pub file_path: String,
    /// The session URL; it is a credential and is never logged.
    pub url: String,
    pub headers: Vec<UploadHeader>,
    /// Stop after sending about this many bytes in this call (whole chunks).
    pub max_bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum UploadOutcomeKind {
    /// The session has every byte.
    Complete,
    /// This call sent its `max_bytes`; call again to continue.
    Partial,
    /// The session is gone (404/410): request a new one and start over.
    Expired,
    /// A network error, 429 or 5xx: query and resume later.
    Interrupted,
    /// Any other response; retrying unchanged will not help.
    Rejected,
    Cancelled,
}

#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResumableUploadOutcome {
    pub outcome: UploadOutcomeKind,
    pub uploaded_bytes: u64,
    pub total_bytes: u64,
    pub status: Option<u16>,
    pub message: Option<String>,
}

#[derive(Clone, Debug, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResumableUploadProgress {
    pub upload_id: String,
    pub uploaded_bytes: u64,
    pub total_bytes: u64,
}

/// Cancellation flags of the uploads in flight, by upload id.
#[derive(Default)]
pub struct ResumableUploads {
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl ResumableUploads {
    pub fn register(&self, upload_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancel_flags
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(upload_id.to_string(), Arc::clone(&flag));
        flag
    }

    pub fn unregister(&self, upload_id: &str) {
        self.cancel_flags
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(upload_id);
    }

    pub fn cancel(&self, upload_id: &str) {
        if let Some(flag) = self
            .cancel_flags
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(upload_id)
        {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

struct Session<'a> {
    client: &'a Client,
    url: &'a str,
    headers: &'a [UploadHeader],
    total: u64,
}

enum Reply {
    Complete,
    /// Bytes the session has stored (the next offset).
    Incomplete(u64),
    Expired(u16),
    Retryable(Option<u16>, String),
    Rejected(u16),
}

impl Session<'_> {
    fn put(&self, content_range: String, body: Body) -> reqwest::Result<Response> {
        let mut request = self
            .client
            .put(self.url)
            .header("Content-Range", content_range)
            .body(body);
        for header in self.headers {
            request = request.header(header.name.as_str(), header.value.as_str());
        }
        request.send()
    }

    fn classify(result: reqwest::Result<Response>) -> Reply {
        let response = match result {
            Ok(response) => response,
            Err(err) => return Reply::Retryable(None, err.without_url().to_string()),
        };
        let status = response.status();
        match status.as_u16() {
            200 | 201 => Reply::Complete,
            308 => Reply::Incomplete(stored_bytes(&response)),
            404 | 410 => Reply::Expired(status.as_u16()),
            429 => Reply::Retryable(Some(429), "Too many requests".to_string()),
            _ if status.is_server_error() => {
                Reply::Retryable(Some(status.as_u16()), "Upload server error".to_string())
            }
            _ => Reply::Rejected(status.as_u16()),
        }
    }

    fn query(&self) -> Reply {
        Self::classify(self.put(format!("bytes */{}", self.total), Body::from(Vec::new())))
    }
}

/// `Range: bytes=0-N` means bytes 0..=N are stored; no header means none.
fn stored_bytes(response: &Response) -> u64 {
    response
        .headers()
        .get("Range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes=0-"))
        .and_then(|end| end.trim().parse::<u64>().ok())
        .map(|end| end + 1)
        .unwrap_or(0)
}

/// Reads one chunk, reporting progress and aborting the request when cancelled.
struct ChunkReader<F: Fn(u64) + Send + 'static> {
    bytes: io::Cursor<Vec<u8>>,
    start: u64,
    reported: u64,
    cancel: Arc<AtomicBool>,
    on_progress: Arc<F>,
}

impl<F: Fn(u64) + Send + Sync + 'static> Read for ChunkReader<F> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.cancel.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "upload cancelled",
            ));
        }
        let read = self.bytes.read(buf)?;
        let position = self.bytes.position();
        if position - self.reported >= PROGRESS_STEP_BYTES {
            self.reported = position;
            (self.on_progress)(self.start + position);
        }
        Ok(read)
    }
}

fn outcome(
    kind: UploadOutcomeKind,
    uploaded_bytes: u64,
    total_bytes: u64,
    status: Option<u16>,
    message: Option<String>,
) -> ResumableUploadOutcome {
    ResumableUploadOutcome {
        outcome: kind,
        uploaded_bytes,
        total_bytes,
        status,
        message,
    }
}

fn reply_outcome(reply: Reply, uploaded: u64, total: u64) -> ResumableUploadOutcome {
    match reply {
        Reply::Complete => outcome(UploadOutcomeKind::Complete, total, total, None, None),
        Reply::Incomplete(stored) => outcome(
            UploadOutcomeKind::Interrupted,
            stored,
            total,
            Some(308),
            None,
        ),
        Reply::Expired(status) => outcome(
            UploadOutcomeKind::Expired,
            uploaded,
            total,
            Some(status),
            None,
        ),
        Reply::Retryable(status, message) => outcome(
            UploadOutcomeKind::Interrupted,
            uploaded,
            total,
            status,
            Some(message),
        ),
        Reply::Rejected(status) => outcome(
            UploadOutcomeKind::Rejected,
            uploaded,
            total,
            Some(status),
            None,
        ),
    }
}

pub fn build_client() -> reqwest::Result<Client> {
    Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()
}

/// One pass over the upload: query what the session has, then send the rest
/// in `chunk_bytes` pieces.
pub fn run_upload<F: Fn(u64) + Send + Sync + 'static>(
    client: &Client,
    path: &Path,
    url: &str,
    headers: &[UploadHeader],
    chunk_bytes: u64,
    max_bytes: Option<u64>,
    cancel: Arc<AtomicBool>,
    on_progress: F,
) -> io::Result<ResumableUploadOutcome> {
    let mut file = File::open(path)?;
    let total = file.metadata()?.len();
    let session = Session {
        client,
        url,
        headers,
        total,
    };
    let on_progress = Arc::new(on_progress);
    let cancelled = |uploaded| outcome(UploadOutcomeKind::Cancelled, uploaded, total, None, None);

    let mut offset = match session.query() {
        Reply::Incomplete(stored) => stored.min(total),
        other => return Ok(reply_outcome(other, 0, total)),
    };
    on_progress(offset);
    let started_at = offset;

    while offset < total {
        if max_bytes.is_some_and(|max| offset - started_at >= max) {
            return Ok(outcome(
                UploadOutcomeKind::Partial,
                offset,
                total,
                None,
                None,
            ));
        }
        if cancel.load(Ordering::SeqCst) {
            return Ok(cancelled(offset));
        }
        let end = (offset + chunk_bytes).min(total);
        let mut bytes = vec![0u8; (end - offset) as usize];
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut bytes)?;

        let progress = Arc::clone(&on_progress);
        let reader = ChunkReader {
            bytes: io::Cursor::new(bytes),
            start: offset,
            reported: 0,
            cancel: Arc::clone(&cancel),
            on_progress: progress,
        };
        let body = Body::sized(reader, end - offset);
        let result = session.put(format!("bytes {}-{}/{}", offset, end - 1, total), body);
        if cancel.load(Ordering::SeqCst) {
            return Ok(cancelled(offset));
        }

        match Session::classify(result) {
            Reply::Complete => {
                on_progress(total);
                return Ok(outcome(
                    UploadOutcomeKind::Complete,
                    total,
                    total,
                    None,
                    None,
                ));
            }
            Reply::Incomplete(stored) => {
                offset = stored.min(total);
                on_progress(offset);
            }
            other => return Ok(reply_outcome(other, offset, total)),
        }
    }

    // Every byte is stored but the session has not confirmed completion.
    Ok(reply_outcome(session.query(), offset, total))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::AtomicUsize;
    use std::thread;

    const CHUNK: u64 = 256 * 1024;

    /// A minimal resumable-upload session: stores bytes in order and answers
    /// like GCS. `fail_put` makes that (1-based) chunk PUT fail with 503
    /// after keeping only its first half.
    struct FakeSession {
        stored: Mutex<Vec<u8>>,
        puts: AtomicUsize,
        fail_put: Option<usize>,
    }

    fn read_request(stream: &mut TcpStream) -> (String, HashMap<String, String>, Vec<u8>) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut request_line = String::new();
        reader.read_line(&mut request_line).unwrap();
        let mut headers = HashMap::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let line = line.trim_end();
            if line.is_empty() {
                break;
            }
            let (name, value) = line.split_once(':').unwrap();
            headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_string());
        }
        let length: usize = headers
            .get("content-length")
            .map(|value| value.parse().unwrap())
            .unwrap_or(0);
        let mut body = vec![0u8; length];
        reader.read_exact(&mut body).unwrap();
        (request_line, headers, body)
    }

    fn respond(stream: &mut TcpStream, status: &str, extra: &str) {
        let response =
            format!("HTTP/1.1 {status}\r\n{extra}Content-Length: 0\r\nConnection: close\r\n\r\n");
        stream.write_all(response.as_bytes()).unwrap();
    }

    fn range_header(stored: usize) -> String {
        if stored == 0 {
            String::new()
        } else {
            format!("Range: bytes=0-{}\r\n", stored - 1)
        }
    }

    fn serve(session: Arc<FakeSession>) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                let (_, headers, body) = read_request(&mut stream);
                let range = headers.get("content-range").cloned().unwrap_or_default();
                let mut stored = session.stored.lock().unwrap();
                if let Some(total) = range.strip_prefix("bytes */") {
                    let total: usize = total.parse().unwrap();
                    if stored.len() == total && total > 0 {
                        respond(&mut stream, "200 OK", "");
                    } else {
                        respond(
                            &mut stream,
                            "308 Resume Incomplete",
                            &range_header(stored.len()),
                        );
                    }
                    continue;
                }
                let put = session.puts.fetch_add(1, Ordering::SeqCst) + 1;
                let (span, total) = range
                    .strip_prefix("bytes ")
                    .unwrap()
                    .split_once('/')
                    .unwrap();
                let (start, _) = span.split_once('-').unwrap();
                let start: usize = start.parse().unwrap();
                let total: usize = total.parse().unwrap();
                assert_eq!(
                    start,
                    stored.len(),
                    "chunks must continue after the stored bytes"
                );
                if Some(put) == session.fail_put {
                    stored.extend_from_slice(&body[..body.len() / 2]);
                    respond(&mut stream, "503 Service Unavailable", "");
                    continue;
                }
                stored.extend_from_slice(&body);
                if stored.len() == total {
                    respond(&mut stream, "200 OK", "");
                } else {
                    respond(
                        &mut stream,
                        "308 Resume Incomplete",
                        &range_header(stored.len()),
                    );
                }
            }
        });
        format!("http://{address}/upload")
    }

    fn temp_file(name: &str, len: usize) -> (std::path::PathBuf, Vec<u8>) {
        let mut path = std::env::temp_dir();
        path.push(format!("voquill-upload-{}-{name}.wav", std::process::id()));
        let bytes: Vec<u8> = (0..len).map(|i| (i % 251) as u8).collect();
        std::fs::write(&path, &bytes).unwrap();
        (path, bytes)
    }

    fn session(fail_put: Option<usize>) -> Arc<FakeSession> {
        Arc::new(FakeSession {
            stored: Mutex::new(Vec::new()),
            puts: AtomicUsize::new(0),
            fail_put,
        })
    }

    fn upload(
        path: &Path,
        url: &str,
        cancel: Arc<AtomicBool>,
        on_progress: impl Fn(u64) + Send + Sync + 'static,
    ) -> ResumableUploadOutcome {
        let client = build_client().unwrap();
        let headers = [UploadHeader {
            name: "Content-Type".to_string(),
            value: "audio/wav".to_string(),
        }];
        run_upload(
            &client,
            path,
            url,
            &headers,
            CHUNK,
            None,
            cancel,
            on_progress,
        )
        .unwrap()
    }

    #[test]
    fn uploads_a_small_file_in_one_put() {
        let (path, bytes) = temp_file("single", 1_000);
        let fake = session(None);
        let url = serve(Arc::clone(&fake));

        let result = upload(&path, &url, Arc::new(AtomicBool::new(false)), |_| {});

        assert_eq!(result.outcome, UploadOutcomeKind::Complete);
        assert_eq!(result.uploaded_bytes, 1_000);
        assert_eq!(fake.puts.load(Ordering::SeqCst), 1);
        assert_eq!(*fake.stored.lock().unwrap(), bytes);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn resumes_an_interrupted_upload_from_the_stored_range() {
        let (path, bytes) = temp_file("resume", (CHUNK * 3 + 1234) as usize);
        let fake = session(Some(2));
        let url = serve(Arc::clone(&fake));

        let first = upload(&path, &url, Arc::new(AtomicBool::new(false)), |_| {});
        assert_eq!(first.outcome, UploadOutcomeKind::Interrupted);
        assert_eq!(first.status, Some(503));
        let stored_after_failure = fake.stored.lock().unwrap().len() as u64;
        assert_eq!(stored_after_failure, CHUNK + CHUNK / 2);

        let progress = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&progress);
        let second = upload(
            &path,
            &url,
            Arc::new(AtomicBool::new(false)),
            move |bytes| seen.lock().unwrap().push(bytes),
        );
        assert_eq!(second.outcome, UploadOutcomeKind::Complete);
        assert_eq!(*fake.stored.lock().unwrap(), bytes);
        let progress = progress.lock().unwrap();
        assert_eq!(progress.first(), Some(&stored_after_failure));
        assert_eq!(progress.last(), Some(&(bytes.len() as u64)));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn reports_complete_when_the_session_already_has_everything() {
        let (path, bytes) = temp_file("done", 2_000);
        let fake = session(None);
        fake.stored.lock().unwrap().extend_from_slice(&bytes);
        let url = serve(Arc::clone(&fake));

        let result = upload(&path, &url, Arc::new(AtomicBool::new(false)), |_| {});
        assert_eq!(result.outcome, UploadOutcomeKind::Complete);
        assert_eq!(fake.puts.load(Ordering::SeqCst), 0);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn stops_when_cancelled() {
        let (path, _) = temp_file("cancel", (CHUNK * 4) as usize);
        let fake = session(None);
        let url = serve(Arc::clone(&fake));
        let cancel = Arc::new(AtomicBool::new(false));
        let trigger = Arc::clone(&cancel);

        let result = upload(&path, &url, cancel, move |bytes| {
            if bytes >= CHUNK {
                trigger.store(true, Ordering::SeqCst);
            }
        });

        assert_eq!(result.outcome, UploadOutcomeKind::Cancelled);
        assert!(fake.stored.lock().unwrap().len() < (CHUNK * 4) as usize);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn stops_after_max_bytes_and_continues_on_the_next_call() {
        let (path, bytes) = temp_file("partial", (CHUNK * 3) as usize);
        let fake = session(None);
        let url = serve(Arc::clone(&fake));
        let client = build_client().unwrap();

        let first = run_upload(
            &client,
            &path,
            &url,
            &[],
            CHUNK,
            Some(CHUNK),
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        assert_eq!(first.outcome, UploadOutcomeKind::Partial);
        assert_eq!(first.uploaded_bytes, CHUNK);

        let second = run_upload(
            &client,
            &path,
            &url,
            &[],
            CHUNK,
            None,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        assert_eq!(second.outcome, UploadOutcomeKind::Complete);
        assert_eq!(*fake.stored.lock().unwrap(), bytes);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn reports_an_expired_session() {
        let (path, _) = temp_file("expired", 100);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        thread::spawn(move || {
            for stream in listener.incoming() {
                let mut stream = stream.unwrap();
                read_request(&mut stream);
                respond(&mut stream, "410 Gone", "");
            }
        });
        let result = upload(
            &path,
            &format!("http://{address}/gone"),
            Arc::new(AtomicBool::new(false)),
            |_| {},
        );
        assert_eq!(result.outcome, UploadOutcomeKind::Expired);
        std::fs::remove_file(path).unwrap();
    }

    /// Uploads to a real session URL: `NOTES_SMOKE_UPLOAD_URL=<url>
    /// NOTES_SMOKE_UPLOAD_FILE=<path> cargo test -- --ignored smoke`.
    #[test]
    #[ignore]
    fn smoke_uploads_to_a_real_session() {
        let url = std::env::var("NOTES_SMOKE_UPLOAD_URL").unwrap();
        let path = std::env::var("NOTES_SMOKE_UPLOAD_FILE").unwrap();
        let client = build_client().unwrap();
        let first = run_upload(
            &client,
            Path::new(&path),
            &url,
            &[],
            CHUNK,
            Some(CHUNK),
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        assert_eq!(first.outcome, UploadOutcomeKind::Partial);
        let second = run_upload(
            &client,
            Path::new(&path),
            &url,
            &[],
            CHUNK,
            None,
            Arc::new(AtomicBool::new(false)),
            |_| {},
        )
        .unwrap();
        assert_eq!(second.outcome, UploadOutcomeKind::Complete);
    }
}
