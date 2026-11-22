use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

const EXPIRY_MARGIN: Duration = Duration::from_secs(60);

struct CachedToken {
    access_token: String,
    // Wall-clock time, so a token that expired while the computer slept is not reused.
    expires_at: SystemTime,
}

/// Short-lived calendar access tokens by calendar account id, so a refresh
/// only happens when the previous token is about to expire.
#[derive(Default)]
pub struct CalendarTokenState {
    tokens: Mutex<HashMap<String, CachedToken>>,
}

impl CalendarTokenState {
    pub fn get(&self, account_id: &str) -> Option<String> {
        let tokens = self.tokens.lock().ok()?;
        let cached = tokens.get(account_id)?;
        (cached.expires_at > SystemTime::now() + EXPIRY_MARGIN).then(|| cached.access_token.clone())
    }

    pub fn set(&self, account_id: &str, access_token: &str, expires_in_secs: i64) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.insert(
                account_id.to_string(),
                CachedToken {
                    access_token: access_token.to_string(),
                    expires_at: SystemTime::now()
                        + Duration::from_secs(expires_in_secs.max(0) as u64),
                },
            );
        }
    }

    pub fn remove(&self, account_id: &str) {
        if let Ok(mut tokens) = self.tokens.lock() {
            tokens.remove(account_id);
        }
    }
}
