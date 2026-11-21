//! System audio on macOS 14.4 and later: a Core Audio process tap on
//! everything the computer plays except Voquill itself, read through a
//! private aggregate device. It needs the "System Audio Recording" permission,
//! which is asked for when the first meeting starts; the meeting records the
//! microphone meanwhile. The tap is rebuilt when the default output device or
//! the tap's format changes (headphones plugged in, a headset switching to its
//! call profile). Older macOS versions record the microphone only.
//!
//! Building a tap before the user has answered the prompt blocks inside Core
//! Audio until the prompt goes away (about 90 s on macOS 26), so the tap is
//! only built once TCC reports the permission granted, and always on this
//! module's own thread.

use std::ffi::{c_void, CStr, CString};
use std::os::raw::{c_char, c_int};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use block::ConcreteBlock;
use cocoa::base::{id, nil};
use cocoa::foundation::{NSAutoreleasePool, NSString};
use core_foundation::array::CFArray;
use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::string::CFStringRef;
use objc::runtime::{Class, YES};
use objc::{class, msg_send, sel, sel_impl};

use crate::platform::system_audio::{
    SystemAudioChunk, SystemAudioChunkCallback, SystemAudioSource, SystemAudioState,
    SystemAudioStateCallback,
};

/// How often a tap that could not be built, or a denied permission, is
/// tried again during a meeting (the user may allow it in System Settings).
const RETRY_INTERVAL: Duration = Duration::from_secs(3);
const TAP_NAME: &str = "Voquill meeting audio";

type AudioObjectId = u32;
type OsStatus = i32;

const fn four_char_code(code: &[u8; 4]) -> u32 {
    u32::from_be_bytes(*code)
}

const SYSTEM_OBJECT: AudioObjectId = 1;
const SCOPE_GLOBAL: u32 = four_char_code(b"glob");
const ELEMENT_MAIN: u32 = 0;
const PROPERTY_TRANSLATE_PID_TO_PROCESS: u32 = four_char_code(b"id2p");
const PROPERTY_DEFAULT_OUTPUT_DEVICE: u32 = four_char_code(b"dOut");
const PROPERTY_TAP_FORMAT: u32 = four_char_code(b"tfmt");
const PROPERTY_NOMINAL_SAMPLE_RATE: u32 = four_char_code(b"nsrt");
const FORMAT_LINEAR_PCM: u32 = four_char_code(b"lpcm");
const FORMAT_FLAG_IS_FLOAT: u32 = 1;

#[repr(C)]
struct PropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

impl PropertyAddress {
    const fn global(selector: u32) -> Self {
        Self {
            selector,
            scope: SCOPE_GLOBAL,
            element: ELEMENT_MAIN,
        }
    }
}

#[repr(C)]
struct AudioBuffer {
    number_channels: u32,
    data_byte_size: u32,
    data: *mut c_void,
}

#[repr(C)]
struct AudioBufferList {
    number_buffers: u32,
    buffers: [AudioBuffer; 1],
}

#[repr(C)]
#[derive(Default)]
struct StreamDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

type IoProc = unsafe extern "C" fn(
    AudioObjectId,
    *const c_void,
    *const AudioBufferList,
    *const c_void,
    *mut AudioBufferList,
    *const c_void,
    *mut c_void,
) -> OsStatus;
type IoProcId = *mut c_void;
type PropertyListener =
    unsafe extern "C" fn(AudioObjectId, u32, *const PropertyAddress, *mut c_void) -> OsStatus;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioObjectGetPropertyData(
        object: AudioObjectId,
        address: *const PropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: *mut u32,
        data: *mut c_void,
    ) -> OsStatus;
    fn AudioObjectAddPropertyListener(
        object: AudioObjectId,
        address: *const PropertyAddress,
        listener: PropertyListener,
        client: *mut c_void,
    ) -> OsStatus;
    fn AudioObjectRemovePropertyListener(
        object: AudioObjectId,
        address: *const PropertyAddress,
        listener: PropertyListener,
        client: *mut c_void,
    ) -> OsStatus;
    fn AudioHardwareCreateAggregateDevice(
        description: CFDictionaryRef,
        device: *mut AudioObjectId,
    ) -> OsStatus;
    fn AudioHardwareDestroyAggregateDevice(device: AudioObjectId) -> OsStatus;
    fn AudioDeviceCreateIOProcID(
        device: AudioObjectId,
        io_proc: IoProc,
        client: *mut c_void,
        io_proc_id: *mut IoProcId,
    ) -> OsStatus;
    fn AudioDeviceDestroyIOProcID(device: AudioObjectId, io_proc_id: IoProcId) -> OsStatus;
    fn AudioDeviceStart(device: AudioObjectId, io_proc_id: IoProcId) -> OsStatus;
    fn AudioDeviceStop(device: AudioObjectId, io_proc_id: IoProcId) -> OsStatus;
}

extern "C" {
    fn dlopen(path: *const c_char, mode: c_int) -> *mut c_void;
    fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
    fn sysctlbyname(
        name: *const c_char,
        old: *mut c_void,
        old_len: *mut usize,
        new: *mut c_void,
        new_len: usize,
    ) -> c_int;
}

const RTLD_DEFAULT: *mut c_void = -2isize as *mut c_void;
const RTLD_NOW: c_int = 2;

unsafe fn symbol(handle: *mut c_void, name: &str) -> Option<*mut c_void> {
    let name = CString::new(name).ok()?;
    let pointer = dlsym(handle, name.as_ptr());
    (!pointer.is_null()).then_some(pointer)
}

/// The process tap functions, looked up at run time: they do not exist
/// before macOS 14.2, and linking them directly would stop Voquill from
/// launching on older versions.
struct ProcessTapApi {
    create: CreateProcessTap,
    destroy: DestroyProcessTap,
}

type CreateProcessTap = unsafe extern "C" fn(id, *mut AudioObjectId) -> OsStatus;
type DestroyProcessTap = unsafe extern "C" fn(AudioObjectId) -> OsStatus;

fn process_tap_api() -> Option<&'static ProcessTapApi> {
    static API: OnceLock<Option<ProcessTapApi>> = OnceLock::new();
    API.get_or_init(|| unsafe {
        let create = symbol(RTLD_DEFAULT, "AudioHardwareCreateProcessTap")?;
        let destroy = symbol(RTLD_DEFAULT, "AudioHardwareDestroyProcessTap")?;
        Some(ProcessTapApi {
            create: std::mem::transmute::<*mut c_void, CreateProcessTap>(create),
            destroy: std::mem::transmute::<*mut c_void, DestroyProcessTap>(destroy),
        })
    })
    .as_ref()
}

fn os_version() -> Option<(u32, u32)> {
    let name = CString::new("kern.osproductversion").ok()?;
    let mut buffer = [0u8; 32];
    let mut length = buffer.len();
    let status = unsafe {
        sysctlbyname(
            name.as_ptr(),
            buffer.as_mut_ptr().cast(),
            &mut length,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 {
        return None;
    }
    let text = CStr::from_bytes_until_nul(&buffer).ok()?.to_str().ok()?;
    let mut parts = text.split('.').map(|part| part.parse::<u32>().ok());
    Some((parts.next()??, parts.next().flatten().unwrap_or(0)))
}

/// Process taps with their permission prompt arrived in macOS 14.4.
pub fn process_taps_supported() -> bool {
    os_version().is_some_and(|version| version >= (14, 4))
        && process_tap_api().is_some()
        && Class::get("CATapDescription").is_some()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Permission {
    Granted,
    Denied,
    Undetermined,
}

/// The TCC service a process tap is checked against. Its prompt is the
/// "System Audio Recording Only" one, not the Screen Recording one.
const AUDIO_CAPTURE_SERVICE: &str = "kTCCServiceAudioCapture";

/// TCC is private, so it is loaded at run time; without it the tap itself
/// shows the prompt when it first starts (blocking this module's thread until
/// it is answered), and a refusal records silence.
struct Tcc {
    preflight: TccPreflight,
    request: TccRequest,
}

type TccPreflight = unsafe extern "C" fn(CFStringRef, CFDictionaryRef) -> c_int;
type TccRequest = unsafe extern "C" fn(CFStringRef, CFDictionaryRef, *const c_void);

fn tcc() -> Option<&'static Tcc> {
    static TCC: OnceLock<Option<Tcc>> = OnceLock::new();
    TCC.get_or_init(|| unsafe {
        let path =
            CString::new("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC").ok()?;
        let handle = dlopen(path.as_ptr(), RTLD_NOW);
        if handle.is_null() {
            return None;
        }
        let preflight = symbol(handle, "TCCAccessPreflight")?;
        let request = symbol(handle, "TCCAccessRequest")?;
        Some(Tcc {
            preflight: std::mem::transmute::<*mut c_void, TccPreflight>(preflight),
            request: std::mem::transmute::<*mut c_void, TccRequest>(request),
        })
    })
    .as_ref()
}

fn audio_capture_permission() -> Permission {
    let Some(tcc) = tcc() else {
        return Permission::Granted;
    };
    let service = CFString::new(AUDIO_CAPTURE_SERVICE);
    match unsafe { (tcc.preflight)(service.as_concrete_TypeRef(), std::ptr::null()) } {
        0 => Permission::Granted,
        1 => Permission::Denied,
        _ => Permission::Undetermined,
    }
}

/// Shows the permission prompt; the answer arrives as a command.
fn request_audio_capture(answer: Sender<Command>) {
    let Some(tcc) = tcc() else {
        let _ = answer.send(Command::Answered(true));
        return;
    };
    let service = CFString::new(AUDIO_CAPTURE_SERVICE);
    let handler = ConcreteBlock::new(move |granted: u8| {
        let _ = answer.send(Command::Answered(granted != 0));
    })
    .copy();
    let handler: &block::Block<(u8,), ()> = &handler;
    unsafe {
        (tcc.request)(
            service.as_concrete_TypeRef(),
            std::ptr::null(),
            (handler as *const block::Block<(u8,), ()>).cast(),
        );
    }
}

unsafe fn read_property<T: Default>(
    object: AudioObjectId,
    selector: u32,
    qualifier: Option<&i32>,
) -> Option<T> {
    let address = PropertyAddress::global(selector);
    let mut value = T::default();
    let mut size = std::mem::size_of::<T>() as u32;
    let (qualifier_size, qualifier) = match qualifier {
        Some(qualifier) => (
            std::mem::size_of::<i32>() as u32,
            (qualifier as *const i32).cast(),
        ),
        None => (0, std::ptr::null()),
    };
    let status = AudioObjectGetPropertyData(
        object,
        &address,
        qualifier_size,
        qualifier,
        &mut size,
        (&mut value as *mut T).cast(),
    );
    (status == 0).then_some(value)
}

fn default_output_device() -> Option<AudioObjectId> {
    unsafe { read_property::<AudioObjectId>(SYSTEM_OBJECT, PROPERTY_DEFAULT_OUTPUT_DEVICE, None) }
        .filter(|device| *device != 0)
}

fn tap_format(tap: AudioObjectId) -> Option<StreamDescription> {
    unsafe { read_property::<StreamDescription>(tap, PROPERTY_TAP_FORMAT, None) }
}

/// Voquill's own Core Audio process object, so the tap leaves its sounds out.
fn own_process_object() -> Option<AudioObjectId> {
    let pid = std::process::id() as i32;
    unsafe {
        read_property::<AudioObjectId>(SYSTEM_OBJECT, PROPERTY_TRANSLATE_PID_TO_PROCESS, Some(&pid))
    }
    .filter(|object| *object != 0)
}

enum Command {
    /// The default output device changed.
    OutputChanged,
    /// The tap's format changed.
    FormatChanged,
    /// The permission prompt was answered.
    Answered(bool),
    Stop,
}

unsafe extern "C" fn on_property_change(
    _object: AudioObjectId,
    count: u32,
    addresses: *const PropertyAddress,
    client: *mut c_void,
) -> OsStatus {
    if client.is_null() || addresses.is_null() {
        return 0;
    }
    let commands = &*(client as *const Sender<Command>);
    for address in std::slice::from_raw_parts(addresses, count as usize) {
        let command = match address.selector {
            PROPERTY_DEFAULT_OUTPUT_DEVICE => Command::OutputChanged,
            PROPERTY_TAP_FORMAT => Command::FormatChanged,
            _ => continue,
        };
        let _ = commands.send(command);
    }
    0
}

struct IoContext {
    on_chunk: SystemAudioChunkCallback,
    sample_rate: u32,
}

unsafe extern "C" fn deliver_tap_audio(
    _device: AudioObjectId,
    _now: *const c_void,
    input: *const AudioBufferList,
    _input_time: *const c_void,
    _output: *mut AudioBufferList,
    _output_time: *const c_void,
    client: *mut c_void,
) -> OsStatus {
    if input.is_null() || client.is_null() {
        return 0;
    }
    let context = &*(client as *const IoContext);
    let list = &*input;
    let buffers = std::slice::from_raw_parts(list.buffers.as_ptr(), list.number_buffers as usize);
    let samples = mono_from_buffers(buffers);
    if !samples.is_empty() {
        (context.on_chunk)(SystemAudioChunk {
            samples,
            sample_rate: context.sample_rate,
        });
    }
    0
}

/// One interleaved buffer, or one buffer per channel.
unsafe fn mono_from_buffers(buffers: &[AudioBuffer]) -> Vec<f32> {
    let channel = |buffer: &AudioBuffer| -> &[f32] {
        if buffer.data.is_null() {
            return &[];
        }
        std::slice::from_raw_parts(
            buffer.data as *const f32,
            buffer.data_byte_size as usize / std::mem::size_of::<f32>(),
        )
    };
    match buffers {
        [] => Vec::new(),
        [single] => crate::platform::audio::downmix_to_mono(
            channel(single),
            single.number_channels as usize,
        ),
        several => {
            let frames = several
                .iter()
                .map(|buffer| channel(buffer).len())
                .min()
                .unwrap_or(0);
            (0..frames)
                .map(|frame| {
                    several
                        .iter()
                        .map(|buffer| channel(buffer)[frame])
                        .sum::<f32>()
                        / several.len() as f32
                })
                .collect()
        }
    }
}

/// A running tap and the private aggregate device that reads it.
struct Tap {
    api: &'static ProcessTapApi,
    tap: AudioObjectId,
    aggregate: AudioObjectId,
    io_proc: IoProcId,
    io_context: *mut IoContext,
    listener: *mut c_void,
    sample_rate: u32,
    output_device: Option<AudioObjectId>,
}

unsafe fn nsstring_to_string(string: id) -> Option<String> {
    if string == nil {
        return None;
    }
    let utf8: *const c_char = msg_send![string, UTF8String];
    (!utf8.is_null()).then(|| CStr::from_ptr(utf8).to_string_lossy().into_owned())
}

/// A mono tap of every process but Voquill's own; returns it with its UID.
unsafe fn create_process_tap(api: &ProcessTapApi) -> Result<(AudioObjectId, String), String> {
    let class = Class::get("CATapDescription").ok_or("CATapDescription is unavailable")?;
    let excluded: id = match own_process_object() {
        Some(object) => {
            let number: id = msg_send![class!(NSNumber), numberWithUnsignedInt: object];
            msg_send![class!(NSArray), arrayWithObject: number]
        }
        None => {
            log::warn!("Voquill has no Core Audio process object yet; its sounds may be recorded");
            msg_send![class!(NSArray), array]
        }
    };
    let description: id = msg_send![class, alloc];
    let description: id = msg_send![description, initMonoGlobalTapButExcludeProcesses: excluded];
    if description == nil {
        return Err("Could not describe the process tap".to_string());
    }
    let name: id = NSString::alloc(nil).init_str(TAP_NAME);
    let _: () = msg_send![description, setName: name];
    let _: () = msg_send![name, release];
    let _: () = msg_send![description, setPrivate: YES];
    let uuid: id = msg_send![description, UUID];
    let uuid_string: id = msg_send![uuid, UUIDString];
    let uid = nsstring_to_string(uuid_string);

    let mut tap: AudioObjectId = 0;
    let status = (api.create)(description, &mut tap);
    let _: () = msg_send![description, release];
    match uid {
        Some(uid) if status == 0 && tap != 0 => Ok((tap, uid)),
        _ => Err(format!("AudioHardwareCreateProcessTap failed ({status})")),
    }
}

fn aggregate_description(tap_uid: &str) -> CFDictionary<CFString, CFType> {
    let sub_tap = CFDictionary::from_CFType_pairs(&[
        (CFString::new("uid"), CFString::new(tap_uid).as_CFType()),
        (CFString::new("drift"), CFBoolean::true_value().as_CFType()),
    ]);
    let taps = CFArray::from_CFTypes(&[sub_tap.as_CFType()]);
    CFDictionary::from_CFType_pairs(&[
        (CFString::new("name"), CFString::new(TAP_NAME).as_CFType()),
        (
            CFString::new("uid"),
            CFString::new(&format!("{tap_uid}-aggregate")).as_CFType(),
        ),
        (
            CFString::new("private"),
            CFBoolean::true_value().as_CFType(),
        ),
        (
            CFString::new("stacked"),
            CFBoolean::false_value().as_CFType(),
        ),
        (
            CFString::new("tapautostart"),
            CFBoolean::true_value().as_CFType(),
        ),
        (CFString::new("taps"), taps.as_CFType()),
    ])
}

impl Tap {
    fn create(on_chunk: &SystemAudioChunkCallback, listener: *mut c_void) -> Result<Self, String> {
        let api = process_tap_api().ok_or("Process taps are unavailable")?;
        unsafe {
            let pool = NSAutoreleasePool::new(nil);
            let created = create_process_tap(api);
            pool.drain();
            let (tap, tap_uid) = created?;
            // From here on, dropping `partial` releases whatever exists so far.
            let mut partial = Tap {
                api,
                tap,
                aggregate: 0,
                io_proc: std::ptr::null_mut(),
                io_context: std::ptr::null_mut(),
                listener: std::ptr::null_mut(),
                sample_rate: 0,
                output_device: default_output_device(),
            };

            let format = tap_format(tap).ok_or("Could not read the tap format")?;
            if format.format_id != FORMAT_LINEAR_PCM
                || format.format_flags & FORMAT_FLAG_IS_FLOAT == 0
                || format.bits_per_channel != 32
            {
                return Err(format!(
                    "Unexpected tap format {:#x}/{:#x}/{} bits",
                    format.format_id, format.format_flags, format.bits_per_channel
                ));
            }

            let description = aggregate_description(&tap_uid);
            let status = AudioHardwareCreateAggregateDevice(
                description.as_concrete_TypeRef(),
                &mut partial.aggregate,
            );
            if status != 0 || partial.aggregate == 0 {
                return Err(format!(
                    "AudioHardwareCreateAggregateDevice failed ({status})"
                ));
            }

            let rate = read_property::<f64>(partial.aggregate, PROPERTY_NOMINAL_SAMPLE_RATE, None)
                .filter(|rate| *rate > 0.0)
                .unwrap_or(format.sample_rate);
            if (rate - format.sample_rate).abs() > 1.0 {
                log::warn!(
                    "System audio tap runs at {} Hz, its device at {rate} Hz",
                    format.sample_rate
                );
            }
            partial.sample_rate = rate.round() as u32;

            partial.io_context = Box::into_raw(Box::new(IoContext {
                on_chunk: on_chunk.clone(),
                sample_rate: partial.sample_rate,
            }));
            let status = AudioDeviceCreateIOProcID(
                partial.aggregate,
                deliver_tap_audio,
                partial.io_context.cast(),
                &mut partial.io_proc,
            );
            if status != 0 || partial.io_proc.is_null() {
                partial.io_proc = std::ptr::null_mut();
                return Err(format!("AudioDeviceCreateIOProcID failed ({status})"));
            }

            let address = PropertyAddress::global(PROPERTY_TAP_FORMAT);
            if AudioObjectAddPropertyListener(tap, &address, on_property_change, listener) == 0 {
                partial.listener = listener;
            }

            let status = AudioDeviceStart(partial.aggregate, partial.io_proc);
            if status != 0 {
                return Err(format!("AudioDeviceStart failed ({status})"));
            }
            log::info!(
                "System audio tap started at {} Hz ({} channel(s))",
                partial.sample_rate,
                format.channels_per_frame
            );
            Ok(partial)
        }
    }

    /// The tap no longer matches the output it was built for.
    fn is_stale(&self, command: &Command) -> bool {
        match command {
            Command::OutputChanged => default_output_device() != self.output_device,
            Command::FormatChanged => tap_format(self.tap)
                .is_some_and(|format| format.sample_rate.round() as u32 != self.sample_rate),
            _ => false,
        }
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        unsafe {
            if !self.listener.is_null() {
                let address = PropertyAddress::global(PROPERTY_TAP_FORMAT);
                AudioObjectRemovePropertyListener(
                    self.tap,
                    &address,
                    on_property_change,
                    self.listener,
                );
            }
            if !self.io_proc.is_null() {
                AudioDeviceStop(self.aggregate, self.io_proc);
                AudioDeviceDestroyIOProcID(self.aggregate, self.io_proc);
            }
            if self.aggregate != 0 {
                AudioHardwareDestroyAggregateDevice(self.aggregate);
            }
            (self.api.destroy)(self.tap);
            // The IO proc is gone, so nothing uses its context any more.
            if !self.io_context.is_null() {
                drop(Box::from_raw(self.io_context));
            }
        }
    }
}

/// Owns the tap for one meeting capture: builds it once permission allows,
/// rebuilds it when the output changes, and tears it down on `Stop`.
fn run_capture(
    commands: Sender<Command>,
    received: Receiver<Command>,
    on_chunk: SystemAudioChunkCallback,
    on_state: SystemAudioStateCallback,
) {
    // Client data of the property listeners; freed after they are removed.
    let listener = Box::into_raw(Box::new(commands.clone())).cast::<c_void>();
    let output_address = PropertyAddress::global(PROPERTY_DEFAULT_OUTPUT_DEVICE);
    let listening_for_output = unsafe {
        AudioObjectAddPropertyListener(SYSTEM_OBJECT, &output_address, on_property_change, listener)
            == 0
    };

    let mut tap: Option<Tap> = None;
    let mut awaiting_answer = false;
    let mut asked = false;
    let mut last_error: Option<String> = None;
    loop {
        if tap.is_none() && !awaiting_answer {
            match audio_capture_permission() {
                Permission::Granted => match Tap::create(&on_chunk, listener) {
                    Ok(created) => {
                        tap = Some(created);
                        last_error = None;
                        on_state(SystemAudioState::Recording);
                    }
                    Err(err) => {
                        if last_error.as_ref() != Some(&err) {
                            log::warn!("System audio tap could not start: {err}");
                        }
                        last_error = Some(err);
                        on_state(SystemAudioState::Failed);
                    }
                },
                Permission::Undetermined if !asked => {
                    asked = true;
                    awaiting_answer = true;
                    on_state(SystemAudioState::Pending);
                    request_audio_capture(commands.clone());
                }
                Permission::Denied | Permission::Undetermined => {
                    on_state(SystemAudioState::Denied);
                }
            }
        }

        let command = if tap.is_some() || awaiting_answer {
            received.recv().ok()
        } else {
            match received.recv_timeout(RETRY_INTERVAL) {
                Ok(command) => Some(command),
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => None,
            }
        };
        match command {
            None | Some(Command::Stop) => break,
            Some(Command::Answered(granted)) => {
                awaiting_answer = false;
                log::info!("System audio permission answered: granted={granted}");
            }
            Some(change) => {
                if tap
                    .as_ref()
                    .is_some_and(|current| current.is_stale(&change))
                {
                    log::info!("System audio output changed; rebuilding the tap");
                    tap = None;
                }
            }
        }
    }

    drop(tap);
    unsafe {
        if listening_for_output {
            AudioObjectRemovePropertyListener(
                SYSTEM_OBJECT,
                &output_address,
                on_property_change,
                listener,
            );
        }
        drop(Box::from_raw(listener.cast::<Sender<Command>>()));
    }
    log::info!("System audio tap stopped");
}

#[derive(Default)]
pub struct ProcessTapSource {
    commands: Mutex<Option<Sender<Command>>>,
}

impl SystemAudioSource for ProcessTapSource {
    fn start(&self, on_chunk: SystemAudioChunkCallback, on_state: SystemAudioStateCallback) {
        self.stop();
        if !process_taps_supported() {
            log::info!(
                "System audio needs macOS 14.4 or later (this is {:?})",
                os_version()
            );
            on_state(SystemAudioState::Unsupported);
            return;
        }
        let (commands, received) = mpsc::channel();
        let thread_commands = commands.clone();
        let thread_state = on_state.clone();
        let spawned = std::thread::Builder::new()
            .name("meeting-system-audio".into())
            .spawn(move || run_capture(thread_commands, received, on_chunk, thread_state));
        match spawned {
            Ok(_) => {
                *self.commands.lock().unwrap_or_else(|p| p.into_inner()) = Some(commands);
            }
            Err(err) => {
                log::error!("Could not start the system audio thread: {err}");
                on_state(SystemAudioState::Failed);
            }
        }
    }

    fn stop(&self) {
        let commands = self
            .commands
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(commands) = commands {
            let _ = commands.send(Command::Stop);
        }
    }

    fn delivers_silence(&self) -> bool {
        true
    }
}
