use sqlx::{sqlite::SqliteRow, Row, SqlitePool};

use crate::domain::CalendarAccount;

const COLUMNS: &str =
    "id, provider, email, created_at, salt, refresh_token_ciphertext, linked_calendar_ids";

fn from_row(row: SqliteRow) -> CalendarAccount {
    CalendarAccount {
        id: row.get("id"),
        provider: row.get("provider"),
        email: row.get("email"),
        created_at: row.get("created_at"),
        salt: row.get("salt"),
        refresh_token_ciphertext: row.get("refresh_token_ciphertext"),
        linked_calendar_ids: serde_json::from_str(&row.get::<String, _>("linked_calendar_ids"))
            .unwrap_or_default(),
    }
}

/// Linking an account that is already linked replaces its credentials and
/// keeps its linked calendars.
pub async fn upsert_calendar_account(
    pool: SqlitePool,
    account: &CalendarAccount,
) -> Result<CalendarAccount, sqlx::Error> {
    let row = sqlx::query(&format!(
        "INSERT INTO calendar_accounts ({COLUMNS})
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
            email = excluded.email,
            salt = excluded.salt,
            refresh_token_ciphertext = excluded.refresh_token_ciphertext
         RETURNING {COLUMNS}"
    ))
    .bind(&account.id)
    .bind(&account.provider)
    .bind(&account.email)
    .bind(account.created_at)
    .bind(&account.salt)
    .bind(&account.refresh_token_ciphertext)
    .bind(encode_calendar_ids(&account.linked_calendar_ids))
    .fetch_one(&pool)
    .await?;

    Ok(from_row(row))
}

pub async fn fetch_calendar_accounts(
    pool: SqlitePool,
) -> Result<Vec<CalendarAccount>, sqlx::Error> {
    let rows = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM calendar_accounts ORDER BY created_at ASC"
    ))
    .fetch_all(&pool)
    .await?;

    Ok(rows.into_iter().map(from_row).collect())
}

pub async fn fetch_calendar_account(
    pool: SqlitePool,
    id: &str,
) -> Result<Option<CalendarAccount>, sqlx::Error> {
    let row = sqlx::query(&format!(
        "SELECT {COLUMNS} FROM calendar_accounts WHERE id = ?1"
    ))
    .bind(id)
    .fetch_optional(&pool)
    .await?;

    Ok(row.map(from_row))
}

pub async fn update_linked_calendar_ids(
    pool: SqlitePool,
    id: &str,
    calendar_ids: &[String],
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE calendar_accounts SET linked_calendar_ids = ?2 WHERE id = ?1")
        .bind(id)
        .bind(encode_calendar_ids(calendar_ids))
        .execute(&pool)
        .await?;

    Ok(())
}

pub async fn delete_calendar_account(pool: SqlitePool, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM calendar_accounts WHERE id = ?1")
        .bind(id)
        .execute(&pool)
        .await?;

    Ok(())
}

fn encode_calendar_ids(calendar_ids: &[String]) -> String {
    serde_json::to_string(calendar_ids).unwrap_or_else(|_| "[]".to_string())
}
