package com.voquill.mobile.keyboard

enum class KeyboardLayer { ALPHA, NUMERIC, SYMBOL }
enum class KeyboardCaseState { LOWER, SHIFT, CAPS_LOCK }

class KeyboardStateMachine {
    var layer: KeyboardLayer = KeyboardLayer.ALPHA
        private set
    var caseState: KeyboardCaseState = KeyboardCaseState.LOWER
        private set

    private var lastShiftTapTime: Long = 0L

    fun onShiftTap() {
        if (layer != KeyboardLayer.ALPHA) return
        val now = System.currentTimeMillis()
        if (now - lastShiftTapTime < 300L && caseState == KeyboardCaseState.SHIFT) {
            caseState = KeyboardCaseState.CAPS_LOCK
        } else {
            caseState = when (caseState) {
                KeyboardCaseState.LOWER -> KeyboardCaseState.SHIFT
                KeyboardCaseState.SHIFT -> KeyboardCaseState.LOWER
                KeyboardCaseState.CAPS_LOCK -> KeyboardCaseState.LOWER
            }
        }
        lastShiftTapTime = now
    }

    fun onCharacterCommit() {
        if (caseState == KeyboardCaseState.SHIFT) {
            caseState = KeyboardCaseState.LOWER
        }
    }

    fun onModeTap() {
        layer = when (layer) {
            KeyboardLayer.ALPHA -> KeyboardLayer.NUMERIC
            KeyboardLayer.NUMERIC -> KeyboardLayer.SYMBOL
            KeyboardLayer.SYMBOL -> KeyboardLayer.ALPHA
        }
    }
}
