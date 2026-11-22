use serde::Serialize;

#[derive(Clone, Debug)]
pub struct CalendarAccount {
    pub id: String,
    pub provider: String,
    pub email: Option<String>,
    pub created_at: i64,
    pub salt: String,
    pub refresh_token_ciphertext: String,
    pub linked_calendar_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CalendarAccountView {
    pub id: String,
    pub provider: String,
    pub email: Option<String>,
    pub created_at: i64,
    pub linked_calendar_ids: Vec<String>,
}

impl From<CalendarAccount> for CalendarAccountView {
    fn from(account: CalendarAccount) -> Self {
        Self {
            id: account.id,
            provider: account.provider,
            email: account.email,
            created_at: account.created_at,
            linked_calendar_ids: account.linked_calendar_ids,
        }
    }
}
