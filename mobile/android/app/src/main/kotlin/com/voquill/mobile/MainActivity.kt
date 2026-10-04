package com.voquill.mobile

import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.provider.Settings
import android.view.inputmethod.InputMethodManager
import com.voquill.flutter_video_looper.FlutterVideoLooperPlugin
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : FlutterFragmentActivity() {
    private var sharedChannel: MethodChannel? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        sharedChannel = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "com.voquill.mobile/shared")
        sharedChannel?.setMethodCallHandler { call, result ->
                when (call.method) {
                    "setKeyboardAuth" -> handleSetKeyboardAuth(call.arguments, result)
                    "clearKeyboardAuth" -> handleClearKeyboardAuth(result)
                    "setKeyboardUser" -> handleSetKeyboardUser(call.arguments, result)
                    "setKeyboardTones" -> handleSetKeyboardTones(call.arguments, result)
                    "setKeyboardDictionary" -> handleSetKeyboardDictionary(call.arguments, result)
                    "setMixpanelUser" -> handleSetMixpanelUser(call.arguments, result)
                    "setMixpanelToken" -> handleSetMixpanelToken(call.arguments, result)
                    "getDictationLanguages" -> result.success(getDictationLanguages())
                    "getActiveDictationLanguage" -> result.success(
                        keyboardPrefs.getString(VoquillIME.KEY_DICTATION_LANGUAGE, null),
                    )
                    "setDictationLanguages" -> handleSetDictationLanguages(call.arguments, result)
                    "setActiveDictationLanguage" -> handleSetActiveDictationLanguage(
                        call.arguments,
                        result,
                    )
                    "getTranscriptions" -> result.success(getTranscriptions())
                    "getSelectedToneId" -> result.success(
                        keyboardPrefs.getString(VoquillIME.KEY_SELECTED_TONE_ID, null),
                    )
                    "setSelectedToneId" -> handleSetSelectedToneId(call.arguments, result)
                    "getAppCounter" -> result.success(
                        keyboardPrefs.getInt(VoquillIME.KEY_APP_UPDATE_COUNTER, 0),
                    )
                    "incrementKeyboardCounter" -> {
                        incrementCounter(VoquillIME.KEY_KEYBOARD_UPDATE_COUNTER)
                        result.success(null)
                    }
                    "setKeyboardAiConfig" -> handleSetKeyboardAiConfig(call.arguments, result)
                    "setKeyboardLayouts" -> handleSetKeyboardLayouts(call.arguments, result)
                    "setKeyboardToolbar" -> handleSetKeyboardToolbar(call.arguments, result)
                    "setKeyboardLanguages" -> handleSetKeyboardLanguages(call.arguments, result)
                    "isKeyboardEnabled" -> result.success(isVoquillKeyboardEnabled())
                    "openKeyboardSettings" -> {
                        val intent = Intent(Settings.ACTION_INPUT_METHOD_SETTINGS).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        startActivity(intent)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }

        maybeShowPaywallFromIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        maybeShowPaywallFromIntent(intent)
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration,
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        FlutterVideoLooperPlugin.onPipModeChanged(isInPictureInPictureMode)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        maybeShowPaywallFromIntent(intent)
    }

    private val keyboardPrefs
        get() = getSharedPreferences(VoquillIME.PREFS_NAME, Context.MODE_PRIVATE)

    private fun handleSetKeyboardAuth(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val apiRefreshToken = args?.get("apiRefreshToken") as? String
        val apiKey = args?.get("apiKey") as? String
        val functionUrl = args?.get("functionUrl") as? String
        val authUrl = args?.get("authUrl") as? String
        if (apiRefreshToken.isNullOrBlank() ||
            apiKey.isNullOrBlank() ||
            functionUrl.isNullOrBlank() ||
            authUrl.isNullOrBlank()
        ) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }

        keyboardPrefs
            .edit()
            .putString(VoquillIME.KEY_API_REFRESH_TOKEN, apiRefreshToken)
            .putString(VoquillIME.KEY_API_KEY, apiKey)
            .putString(VoquillIME.KEY_FUNCTION_URL, functionUrl)
            .putString(VoquillIME.KEY_AUTH_URL, authUrl)
            .apply()
        result.success(null)
    }

    private fun handleClearKeyboardAuth(result: MethodChannel.Result) {
        keyboardPrefs
            .edit()
            .remove(VoquillIME.KEY_API_REFRESH_TOKEN)
            .remove(VoquillIME.KEY_API_KEY)
            .remove(VoquillIME.KEY_FUNCTION_URL)
            .remove(VoquillIME.KEY_AUTH_URL)
            .apply()
        result.success(null)
    }

    private fun handleSetKeyboardUser(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val userName = args?.get("userName") as? String
        if (userName.isNullOrBlank()) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }

        keyboardPrefs
            .edit()
            .putString(VoquillIME.KEY_USER_NAME, userName)
            .apply()
        result.success(null)
    }

    private fun handleSetKeyboardTones(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val selectedToneId = args?.get("selectedToneId") as? String
        val activeToneIds = parseStringList(args?.get("activeToneIds"))
        val toneById = args?.get("toneById") as? Map<*, *>
        if (selectedToneId.isNullOrBlank() || activeToneIds == null || toneById == null) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }

        keyboardPrefs
            .edit()
            .putString(VoquillIME.KEY_SELECTED_TONE_ID, selectedToneId)
            .putString(VoquillIME.KEY_ACTIVE_TONE_IDS, JSONArray(activeToneIds).toString())
            .putString(VoquillIME.KEY_TONE_BY_ID, mapToJson(toneById).toString())
            .apply()
        result.success(null)
    }

    private fun handleSetKeyboardDictionary(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val termIds = parseStringList(args?.get("termIds"))
        val termById = args?.get("termById") as? Map<*, *>
        if (termIds == null || termById == null) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }

        keyboardPrefs
            .edit()
            .putString(VoquillIME.KEY_TERM_IDS, JSONArray(termIds).toString())
            .putString(VoquillIME.KEY_TERM_BY_ID, mapToJson(termById).toString())
            .apply()
        result.success(null)
    }

    private fun handleSetMixpanelUser(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val uid = args?.get("uid") as? String
        if (uid.isNullOrBlank()) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }
        keyboardPrefs.edit().putString(VoquillIME.KEY_MIXPANEL_UID, uid).apply()
        result.success(null)
    }

    private fun handleSetMixpanelToken(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val token = args?.get("token") as? String
        if (token.isNullOrBlank()) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }
        keyboardPrefs.edit().putString(VoquillIME.KEY_MIXPANEL_TOKEN, token).apply()
        result.success(null)
    }

    private fun handleSetDictationLanguages(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val languages = parseStringList(args?.get("languages"))
        if (languages == null) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }
        keyboardPrefs
            .edit()
            .putString(VoquillIME.KEY_DICTATION_LANGUAGES, JSONArray(languages).toString())
            .apply()
        result.success(null)
    }

    private fun handleSetActiveDictationLanguage(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val language = args?.get("language") as? String
        if (language.isNullOrBlank()) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }
        keyboardPrefs.edit().putString(VoquillIME.KEY_DICTATION_LANGUAGE, language).apply()
        result.success(null)
    }

    private fun handleSetSelectedToneId(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val toneId = args?.get("toneId") as? String
        if (toneId.isNullOrBlank()) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }
        keyboardPrefs.edit().putString(VoquillIME.KEY_SELECTED_TONE_ID, toneId).apply()
        result.success(null)
    }

    private fun handleSetKeyboardAiConfig(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val transcriptionMode = args?.get("transcriptionMode") as? String
        val postProcessingMode = args?.get("postProcessingMode") as? String
        if (transcriptionMode.isNullOrBlank() || postProcessingMode.isNullOrBlank()) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }

        val editor = keyboardPrefs.edit()
            .putString(VoquillIME.KEY_AI_TRANSCRIPTION_MODE, transcriptionMode)
            .putString(VoquillIME.KEY_AI_POST_PROCESSING_MODE, postProcessingMode)

        fun putOrRemove(key: String, argKey: String) {
            val value = args?.get(argKey) as? String
            if (value != null) editor.putString(key, value)
            else editor.remove(key)
        }

        putOrRemove(VoquillIME.KEY_AI_TRANSCRIPTION_PROVIDER, "transcriptionProvider")
        putOrRemove(VoquillIME.KEY_AI_TRANSCRIPTION_API_KEY, "transcriptionApiKey")
        putOrRemove(VoquillIME.KEY_AI_POST_PROCESSING_PROVIDER, "postProcessingProvider")
        putOrRemove(VoquillIME.KEY_AI_POST_PROCESSING_API_KEY, "postProcessingApiKey")
        putOrRemove(VoquillIME.KEY_AI_TRANSCRIPTION_BASE_URL, "transcriptionBaseUrl")
        putOrRemove(VoquillIME.KEY_AI_POST_PROCESSING_BASE_URL, "postProcessingBaseUrl")
        putOrRemove(VoquillIME.KEY_AI_TRANSCRIPTION_MODEL, "transcriptionModel")
        putOrRemove(VoquillIME.KEY_AI_POST_PROCESSING_MODEL, "postProcessingModel")
        putOrRemove(VoquillIME.KEY_AI_TRANSCRIPTION_AZURE_REGION, "transcriptionAzureRegion")

        editor.apply()
        result.success(null)
    }

    private fun handleSetKeyboardLayouts(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val layouts = args?.get("layouts")
        val activeLanguage = args?.get("activeLanguage") as? String
        if (layouts == null || activeLanguage.isNullOrBlank()) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }
        val json = JSONObject().apply {
            put("layouts", layouts)
            put("activeLanguage", activeLanguage)
        }
        keyboardPrefs.edit().putString(VoquillIME.KEY_KEYBOARD_LAYOUTS, json.toString()).apply()
        result.success(null)
    }

    private fun handleSetKeyboardToolbar(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val activeMode = args?.get("activeMode") as? String
        val visibleActions = args?.get("visibleActions")
        if (activeMode.isNullOrBlank() || visibleActions == null) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }
        val json = JSONObject().apply {
            put("activeMode", activeMode)
            put("visibleActions", visibleActions)
        }
        keyboardPrefs.edit().putString(VoquillIME.KEY_KEYBOARD_TOOLBAR, json.toString()).apply()
        result.success(null)
    }

    private fun handleSetKeyboardLanguages(arguments: Any?, result: MethodChannel.Result) {
        val args = arguments as? Map<*, *>
        val languages = args?.get("languages")
        val activeLanguage = args?.get("activeLanguage") as? String
        val languageMetadata = args?.get("languageMetadata")
        if (languages == null || activeLanguage.isNullOrBlank()) {
            result.error("INVALID_ARGS", "Missing required arguments", null)
            return
        }
        val json = JSONObject().apply {
            put("languages", languages)
            put("activeLanguage", activeLanguage)
            if (languageMetadata != null) put("languageMetadata", languageMetadata)
        }
        keyboardPrefs.edit().putString(VoquillIME.KEY_KEYBOARD_LANGUAGES, json.toString()).apply()
        result.success(null)
    }

    private fun getDictationLanguages(): List<String> {
        val raw = keyboardPrefs.getString(VoquillIME.KEY_DICTATION_LANGUAGES, null) ?: return emptyList()
        return try {
            val json = JSONArray(raw)
            val out = ArrayList<String>(json.length())
            for (i in 0 until json.length()) {
                out.add(json.optString(i))
            }
            out
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun getTranscriptions(): List<Map<String, Any?>> {
        val raw = keyboardPrefs.getString(VoquillIME.KEY_TRANSCRIPTIONS, null) ?: return emptyList()
        return try {
            val json = JSONArray(raw)
            val out = ArrayList<Map<String, Any?>>(json.length())
            for (i in 0 until json.length()) {
                val item = json.optJSONObject(i) ?: continue
                out.add(jsonObjectToMap(item))
            }
            out
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun incrementCounter(key: String) {
        val next = keyboardPrefs.getInt(key, 0) + 1
        keyboardPrefs.edit().putInt(key, next).apply()
    }

    private fun isVoquillKeyboardEnabled(): Boolean {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager ?: return false
        return imm.enabledInputMethodList.any {
            it.packageName == packageName && it.serviceName.endsWith("VoquillIME")
        }
    }

    private fun parseStringList(value: Any?): List<String>? {
        val list = value as? List<*> ?: return null
        return list.mapNotNull { it as? String }
    }

    private fun mapToJson(map: Map<*, *>): JSONObject {
        val out = JSONObject()
        for ((key, value) in map) {
            key ?: continue
            out.put(key.toString(), toJsonValue(value))
        }
        return out
    }

    private fun listToJson(list: List<*>): JSONArray {
        val out = JSONArray()
        for (item in list) {
            out.put(toJsonValue(item))
        }
        return out
    }

    private fun toJsonValue(value: Any?): Any? {
        return when (value) {
            null -> JSONObject.NULL
            is Map<*, *> -> mapToJson(value)
            is List<*> -> listToJson(value)
            else -> value
        }
    }

    private fun jsonObjectToMap(json: JSONObject): Map<String, Any?> {
        val out = HashMap<String, Any?>()
        val keys = json.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            out[key] = jsonValueToAny(json.opt(key))
        }
        return out
    }

    private fun jsonArrayToList(json: JSONArray): List<Any?> {
        val out = ArrayList<Any?>(json.length())
        for (i in 0 until json.length()) {
            out.add(jsonValueToAny(json.opt(i)))
        }
        return out
    }

    private fun jsonValueToAny(value: Any?): Any? {
        return when (value) {
            JSONObject.NULL -> null
            is JSONObject -> jsonObjectToMap(value)
            is JSONArray -> jsonArrayToList(value)
            else -> value
        }
    }

    private fun maybeShowPaywallFromIntent(intent: Intent?) {
        if (intent?.getBooleanExtra(VoquillIME.EXTRA_SHOW_PAYWALL, false) != true) {
            return
        }
        intent.removeExtra(VoquillIME.EXTRA_SHOW_PAYWALL)
        sharedChannel?.invokeMethod("showPaywall", null)
    }
}
