package com.voquill.mobile.keyboard

import org.json.JSONArray
import org.json.JSONObject

data class KeyboardBottomRow(
    val mode: KeyboardKeySpec,
    val globe: KeyboardKeySpec,
    val space: KeyboardKeySpec,
    val delete: KeyboardKeySpec,
    val enter: KeyboardKeySpec,
)

data class KeyboardLayoutSpec(
    val languageCode: String,
    val alphaRows: List<List<KeyboardKeySpec>>,
    val numericRows: List<List<KeyboardKeySpec>>,
    val symbolRows: List<List<KeyboardKeySpec>>,
    val shift: KeyboardKeySpec,
    val bottomRow: KeyboardBottomRow,
) {
    companion object {
        fun fromJson(json: JSONObject): KeyboardLayoutSpec {
            val languageCode = json.optString("languageCode", "en")
            val alphaRows = parseRows(json.optJSONArray("alphaRows") ?: JSONArray())
            val numericRows = parseRows(json.optJSONArray("numericRows") ?: JSONArray())
            val symbolRows = parseRows(json.optJSONArray("symbolRows") ?: JSONArray())
            val shiftJson = json.optJSONObject("shift")
            val shift = if (shiftJson != null) parseKey(shiftJson) else KeyboardKeySpec(
                id = "shift", role = KeyboardKeyRole.SHIFT, label = "⇧"
            )
            val bottomRowJson = json.optJSONObject("bottomRow")
            val bottomRow = if (bottomRowJson != null) {
                KeyboardBottomRow(
                    mode = parseKey(bottomRowJson.optJSONObject("mode") ?: defaultModeKey()),
                    globe = parseKey(bottomRowJson.optJSONObject("globe") ?: defaultGlobeKey()),
                    space = parseKey(bottomRowJson.optJSONObject("space") ?: defaultSpaceKey()),
                    delete = parseKey(bottomRowJson.optJSONObject("delete") ?: defaultDeleteKey()),
                    enter = parseKey(bottomRowJson.optJSONObject("enter") ?: defaultEnterKey()),
                )
            } else {
                KeyboardBottomRow(
                    mode = parseKey(defaultModeKey()),
                    globe = parseKey(defaultGlobeKey()),
                    space = parseKey(defaultSpaceKey()),
                    delete = parseKey(defaultDeleteKey()),
                    enter = parseKey(defaultEnterKey()),
                )
            }
            return KeyboardLayoutSpec(
                languageCode = languageCode,
                alphaRows = alphaRows,
                numericRows = numericRows,
                symbolRows = symbolRows,
                shift = shift,
                bottomRow = bottomRow,
            )
        }

        fun parseRows(arr: JSONArray): List<List<KeyboardKeySpec>> {
            val rows = mutableListOf<List<KeyboardKeySpec>>()
            for (i in 0 until arr.length()) {
                val rowArr = arr.optJSONArray(i) ?: continue
                val row = mutableListOf<KeyboardKeySpec>()
                for (j in 0 until rowArr.length()) {
                    val keyObj = rowArr.optJSONObject(j) ?: continue
                    row.add(parseKey(keyObj))
                }
                rows.add(row)
            }
            return rows
        }

        fun parseKey(obj: JSONObject): KeyboardKeySpec {
            return KeyboardKeySpec(
                id = obj.optString("id", ""),
                role = KeyboardKeyRole.from(obj.optString("role", "")),
                label = obj.optString("label", ""),
                flex = obj.optInt("flex", 1),
                value = obj.optString("value").takeIf { it.isNotEmpty() },
            )
        }

        private fun defaultModeKey() = JSONObject().apply {
            put("id", "mode"); put("role", "mode"); put("label", "123"); put("flex", 1)
        }

        private fun defaultGlobeKey() = JSONObject().apply {
            put("id", "globe"); put("role", "globe"); put("label", "🌐"); put("flex", 1)
        }

        private fun defaultSpaceKey() = JSONObject().apply {
            put("id", "space"); put("role", "space"); put("label", "space"); put("flex", 4)
        }

        private fun defaultDeleteKey() = JSONObject().apply {
            put("id", "delete"); put("role", "delete"); put("label", "⌫"); put("flex", 1)
        }

        private fun defaultEnterKey() = JSONObject().apply {
            put("id", "enter"); put("role", "enter"); put("label", "return"); put("flex", 1)
        }
    }
}
