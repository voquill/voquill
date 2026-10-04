package com.voquill.mobile.keyboard

data class KeyboardKeySpec(
    val id: String,
    val role: KeyboardKeyRole,
    val label: String,
    val flex: Int = 1,
    val value: String? = null,
)

enum class KeyboardKeyRole {
    CHARACTER, SHIFT, DELETE, SPACE, ENTER, MODE, GLOBE, LANGUAGE, OVERFLOW, START_STOP, UNKNOWN;

    companion object {
        fun from(s: String) = when (s) {
            "character" -> CHARACTER
            "shift" -> SHIFT
            "delete" -> DELETE
            "space" -> SPACE
            "enter" -> ENTER
            "mode" -> MODE
            "globe" -> GLOBE
            "language" -> LANGUAGE
            "overflow" -> OVERFLOW
            "startStop" -> START_STOP
            else -> UNKNOWN
        }
    }
}
