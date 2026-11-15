use std::io::{self, BufRead, Write};
use std::sync::mpsc::Sender;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Visibility {
    Hidden,
    WhileActive,
    Persistent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Recording,
    Loading,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PillMessage {
    pub id: String,
    pub content: Option<String>,
    pub is_error: bool,
    pub is_tool_result: bool,
    pub tool_name: Option<String>,
    pub tool_description: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PillToolCall {
    #[allow(dead_code)]
    pub id: String,
    pub name: String,
    pub done: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PillStreaming {
    pub message_id: String,
    pub tool_calls: Vec<PillToolCall>,
    pub reasoning: String,
    pub is_streaming: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PillPermission {
    pub id: String,
    pub tool_name: String,
    pub description: Option<String>,
    pub reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InMessage {
    Phase { phase: Phase },
    Levels { levels: Vec<f32> },
    StyleInfo { count: u32, name: String },
    Visibility { visibility: Visibility },
    WindowSize { size: String },
    Toast {
        message: String,
        toast_type: Option<String>,
        duration: Option<f64>,
        action: Option<String>,
        action_label: Option<String>,
    },
    DismissToast,
    Fireworks { message: String },
    Flame { message: String },
    FlashBlue,
    BroadcastTranscript { text: String },
    AssistantState {
        active: bool,
        input_mode: String,
        compact: bool,
        user_prompt: Option<String>,
        messages: Vec<PillMessage>,
        streaming: Option<PillStreaming>,
        permissions: Vec<PillPermission>,
    },
    Quit,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutMessage {
    Ready,
    Hover { hovered: bool },
    Click,
    StyleSwitch { direction: String },
    AgentTalk,
    AssistantClose,
    EnableTypeMode,
    TypedMessage { text: String },
    ResolvePermission {
        permission_id: String,
        status: String,
        always_allow: bool,
    },
    CancelDictation,
    ToastAction { action: String },
}

pub fn send(msg: &OutMessage) {
    let mut stdout = io::stdout().lock();
    let _ = serde_json::to_writer(&mut stdout, msg);
    let _ = stdout.write_all(b"\n");
    let _ = stdout.flush();
}

pub fn start_stdin_reader(sender: Sender<InMessage>) {
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let reader = stdin.lock();
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<InMessage>(&line) {
                Ok(msg) => {
                    if sender.send(msg).is_err() {
                        break;
                    }
                }
                Err(e) => {
                    eprintln!("[pill] bad message: {e}");
                }
            }
        }
        let _ = sender.send(InMessage::Quit);
    });
}
