package com.voquill.mobile.keyboard

import android.content.Context
import android.view.Gravity
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView

class KeyboardToolbarController(private val context: Context) {

    private var toolbarView: LinearLayout? = null

    fun buildToolbar(
        visibleActions: List<String>,
        activeLanguage: String,
        activeMode: String,
        isDark: Boolean,
        onStartStop: () -> Unit,
        onLanguage: () -> Unit,
        onMode: () -> Unit,
        onOverflow: () -> Unit,
    ): View {
        val density = context.resources.displayMetrics.density

        val toolbar = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(
                (12 * density).toInt(), (4 * density).toInt(),
                (12 * density).toInt(), (4 * density).toInt()
            )
        }
        toolbarView = toolbar

        val textColor = if (isDark) 0xFFFFFFFF.toInt() else 0xFF000000.toInt()
        val chipBg = if (isDark) 0xFF3A3A3C.toInt() else 0xFFD1D1D6.toInt()

        fun makeChip(label: String, onClick: () -> Unit): TextView = TextView(context).apply {
            text = label
            textSize = 13f
            setTextColor(textColor)
            setPadding(
                (10 * density).toInt(), (4 * density).toInt(),
                (10 * density).toInt(), (4 * density).toInt()
            )
            background = android.graphics.drawable.GradientDrawable().apply {
                setColor(chipBg)
                cornerRadius = 8 * density
            }
            setOnClickListener { onClick() }
        }

        fun chipParams(weight: Float = 0f, width: Int = LinearLayout.LayoutParams.WRAP_CONTENT) =
            LinearLayout.LayoutParams(width, (32 * density).toInt(), weight).apply {
                marginEnd = (8 * density).toInt()
            }

        // Start/Stop button
        if ("startStop" in visibleActions) {
            val startStop = makeChip("⏺", onStartStop)
            toolbar.addView(startStop, chipParams())
        }

        // Spacer
        val spacer = View(context)
        toolbar.addView(spacer, LinearLayout.LayoutParams(0, 1, 1f))

        // Language chip
        if ("language" in visibleActions) {
            val langChip = makeChip(activeLanguage.substringBefore("-").uppercase(), onLanguage).apply {
                tag = "toolbar_language"
            }
            toolbar.addView(langChip, chipParams())
        }

        // Mode chip
        if ("mode" in visibleActions) {
            val modeChip = makeChip(activeMode, onMode).apply {
                tag = "toolbar_mode"
            }
            toolbar.addView(modeChip, chipParams())
        }

        // Overflow
        val overflow = makeChip("⋯", onOverflow).apply { tag = "toolbar_overflow" }
        toolbar.addView(overflow, chipParams())

        return toolbar
    }

    fun updateLanguage(activeLanguage: String) {
        val chip = toolbarView?.findViewWithTag<TextView>("toolbar_language") ?: return
        chip.text = activeLanguage.substringBefore("-").uppercase()
    }

    fun updateMode(activeMode: String) {
        val chip = toolbarView?.findViewWithTag<TextView>("toolbar_mode") ?: return
        chip.text = activeMode
    }
}
