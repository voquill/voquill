package com.voquill.mobile.keyboard

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

class KeyboardMatrixRenderer(
    private val context: Context,
    private val onKeyTap: (KeyboardKeySpec) -> Unit,
) {
    companion object {
        private const val KEY_HEIGHT_DP = 44
        private const val KEY_CORNER_RADIUS_DP = 6f
        private const val KEY_MARGIN_DP = 3
        private const val KEY_TAG = "keyboard_key_spec"

        private const val COLOR_KEY_LIGHT = 0xFFFFFFFF.toInt()
        private const val COLOR_KEY_DARK = 0xFF3A3A3C.toInt()
        private const val COLOR_ACTION_KEY_LIGHT = 0xFFADB5BD.toInt()
        private const val COLOR_ACTION_KEY_DARK = 0xFF1C1C1E.toInt()
        private const val COLOR_TEXT_LIGHT = 0xFF000000.toInt()
        private const val COLOR_TEXT_DARK = 0xFFFFFFFF.toInt()
        private const val COLOR_BG_LIGHT = 0xFFD1D5DB.toInt()
        private const val COLOR_BG_DARK = 0xFF111111.toInt()

        private const val TAG_SHIFT_VIEW = "shift_view"
        private const val TAG_MODE_VIEW = "mode_view"
    }

    fun buildMatrixView(
        layout: KeyboardLayoutSpec,
        state: KeyboardStateMachine,
        isDark: Boolean,
    ): View {
        val density = context.resources.displayMetrics.density
        val keyHeightPx = (KEY_HEIGHT_DP * density).toInt()
        val keyMarginPx = (KEY_MARGIN_DP * density).toInt()
        val bgColor = if (isDark) COLOR_BG_DARK else COLOR_BG_LIGHT
        val textColor = if (isDark) COLOR_TEXT_DARK else COLOR_TEXT_LIGHT
        val keyColor = if (isDark) COLOR_KEY_DARK else COLOR_KEY_LIGHT
        val actionKeyColor = if (isDark) COLOR_ACTION_KEY_DARK else COLOR_ACTION_KEY_LIGHT

        val container = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(bgColor)
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.MATCH_PARENT,
            )
        }

        val activeRows = when (state.layer) {
            KeyboardLayer.ALPHA -> layout.alphaRows
            KeyboardLayer.NUMERIC -> layout.numericRows
            KeyboardLayer.SYMBOL -> layout.symbolRows
        }

        // Character rows with shift key on last alpha row
        activeRows.forEachIndexed { rowIndex, row ->
            val rowView = buildRowView(keyHeightPx, keyMarginPx)

            if (state.layer == KeyboardLayer.ALPHA && rowIndex == activeRows.size - 1) {
                // Add shift key before the last alpha row keys
                val shiftView = buildKeyView(layout.shift, keyColor, actionKeyColor, textColor, keyMarginPx, isDark).apply {
                    (layoutParams as LinearLayout.LayoutParams).weight = layout.shift.flex.toFloat()
                    tag = TAG_SHIFT_VIEW
                    updateShiftLabel(this, state)
                }
                rowView.addView(shiftView)
            }

            row.forEach { key ->
                val displayKey = if (state.layer == KeyboardLayer.ALPHA &&
                    state.caseState != KeyboardCaseState.LOWER &&
                    key.role == KeyboardKeyRole.CHARACTER) {
                    key.copy(label = key.label.uppercase())
                } else {
                    key
                }
                rowView.addView(buildKeyView(displayKey, keyColor, actionKeyColor, textColor, keyMarginPx, isDark))
            }

            if (state.layer == KeyboardLayer.ALPHA && rowIndex == activeRows.size - 1) {
                // Add delete key after the last alpha row keys
                val deleteKey = layout.bottomRow.delete
                rowView.addView(buildKeyView(deleteKey, actionKeyColor, actionKeyColor, textColor, keyMarginPx, isDark).apply {
                    (layoutParams as LinearLayout.LayoutParams).weight = deleteKey.flex.toFloat()
                })
            }

            container.addView(rowView)
        }

        // Bottom row
        val bottomRowView = buildRowView(keyHeightPx, keyMarginPx)
        val bottomRow = layout.bottomRow
        listOf(bottomRow.mode, bottomRow.globe, bottomRow.space, bottomRow.enter).forEach { key ->
            val displayKey = if (key.role == KeyboardKeyRole.MODE) {
                key.copy(label = modeLabel(state.layer))
            } else {
                key
            }
            val isAction = key.role != KeyboardKeyRole.SPACE
            val bgCol = if (isAction) actionKeyColor else keyColor
            val keyView = buildKeyView(displayKey, bgCol, actionKeyColor, textColor, keyMarginPx, isDark).apply {
                (layoutParams as LinearLayout.LayoutParams).weight = key.flex.toFloat()
                if (key.role == KeyboardKeyRole.MODE) tag = TAG_MODE_VIEW
            }
            bottomRowView.addView(keyView)
        }
        container.addView(bottomRowView)

        return container
    }

    fun updateShiftState(matrixView: View, state: KeyboardStateMachine) {
        val container = matrixView as? LinearLayout ?: return
        findViewWithTag(container, TAG_SHIFT_VIEW)?.let { shiftView ->
            updateShiftLabel(shiftView as TextView, state)
        }
        findViewWithTag(container, TAG_MODE_VIEW)?.let { modeView ->
            (modeView as TextView).text = modeLabel(state.layer)
        }
    }

    private fun buildRowView(keyHeightPx: Int, keyMarginPx: Int): LinearLayout {
        return LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                keyHeightPx + keyMarginPx * 2,
            )
            setPadding(keyMarginPx, keyMarginPx, keyMarginPx, keyMarginPx)
        }
    }

    private fun buildKeyView(
        key: KeyboardKeySpec,
        bgColor: Int,
        actionBgColor: Int,
        textColor: Int,
        marginPx: Int,
        isDark: Boolean,
    ): TextView {
        val density = context.resources.displayMetrics.density
        val cornerRadiusPx = KEY_CORNER_RADIUS_DP * density

        return TextView(context).apply {
            text = key.label
            gravity = Gravity.CENTER
            setTextColor(textColor)
            textSize = if (key.role == KeyboardKeyRole.CHARACTER) 18f else 14f
            typeface = if (key.role == KeyboardKeyRole.CHARACTER) Typeface.DEFAULT else Typeface.DEFAULT_BOLD
            setTag(R.id.key_spec_tag, key)

            val drawable = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = cornerRadiusPx
                setColor(bgColor)
            }
            background = drawable

            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.MATCH_PARENT).apply {
                weight = key.flex.toFloat()
                setMargins(marginPx, marginPx, marginPx, marginPx)
            }

            setOnClickListener { onKeyTap(key) }
        }
    }

    private fun updateShiftLabel(view: TextView, state: KeyboardStateMachine) {
        view.text = when (state.caseState) {
            KeyboardCaseState.LOWER -> "⇧"
            KeyboardCaseState.SHIFT -> "⬆"
            KeyboardCaseState.CAPS_LOCK -> "⇪"
        }
    }

    private fun modeLabel(layer: KeyboardLayer): String = when (layer) {
        KeyboardLayer.ALPHA -> "123"
        KeyboardLayer.NUMERIC -> "#+="
        KeyboardLayer.SYMBOL -> "ABC"
    }

    private fun findViewWithTag(parent: LinearLayout, tag: String): View? {
        for (i in 0 until parent.childCount) {
            val child = parent.getChildAt(i)
            if (child.tag == tag) return child
            if (child is LinearLayout) {
                val found = findViewWithTag(child, tag)
                if (found != null) return found
            }
        }
        return null
    }
}
