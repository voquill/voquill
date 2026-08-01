import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate {
  private static let appGroupId = "group.com.voquill.mobile"
  private var channel: FlutterMethodChannel?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    DictationService.shared.cleanupOnLaunch()

    let controller = window?.rootViewController as! FlutterViewController
    let channel = FlutterMethodChannel(
      name: "com.voquill.mobile/shared",
      binaryMessenger: controller.binaryMessenger
    )
    self.channel = channel

    channel.setMethodCallHandler { (call, result) in
      switch call.method {
      case "setKeyboardAuth":
        guard let args = call.arguments as? [String: String],
              let apiRefreshToken = args["apiRefreshToken"],
              let apiKey = args["apiKey"],
              let functionUrl = args["functionUrl"],
              let authUrl = args["authUrl"],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        defaults.set(apiRefreshToken, forKey: "voquill_api_refresh_token")
        defaults.set(apiKey, forKey: "voquill_api_key")
        defaults.set(functionUrl, forKey: "voquill_function_url")
        defaults.set(authUrl, forKey: "voquill_auth_url")
        result(nil)

      case "clearKeyboardAuth":
        if let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) {
          defaults.removeObject(forKey: "voquill_api_refresh_token")
          defaults.removeObject(forKey: "voquill_api_key")
          defaults.removeObject(forKey: "voquill_function_url")
          defaults.removeObject(forKey: "voquill_auth_url")
        }
        result(nil)

      case "setKeyboardUser":
        guard let args = call.arguments as? [String: String],
              let userName = args["userName"],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        defaults.set(userName, forKey: "voquill_user_name")
        result(nil)

      case "setKeyboardTones":
        guard let args = call.arguments as? [String: Any],
              let selectedToneId = args["selectedToneId"] as? String,
              let activeToneIds = args["activeToneIds"] as? [String],
              let toneById = args["toneById"] as? [String: [String: String]],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        defaults.set(selectedToneId, forKey: "voquill_selected_tone_id")
        defaults.set(activeToneIds, forKey: "voquill_active_tone_ids")
        if let data = try? JSONSerialization.data(withJSONObject: toneById) {
          defaults.set(data, forKey: "voquill_tone_by_id")
        }
        result(nil)

      case "setKeyboardDictionary":
        guard let args = call.arguments as? [String: Any],
              let termIds = args["termIds"] as? [String],
              let termById = args["termById"] as? [String: [String: Any]],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        defaults.set(termIds, forKey: "voquill_term_ids")
        if let data = try? JSONSerialization.data(withJSONObject: termById) {
          defaults.set(data, forKey: "voquill_term_by_id")
        }
        result(nil)

      case "setMixpanelUser":
        guard let args = call.arguments as? [String: String],
              let uid = args["uid"],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        defaults.set(uid, forKey: "voquill_mixpanel_uid")
        result(nil)

      case "setMixpanelToken":
        guard let args = call.arguments as? [String: String],
              let token = args["token"],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        defaults.set(token, forKey: "voquill_mixpanel_token")
        result(nil)

      case "getDictationLanguages":
        let defaults = UserDefaults(suiteName: AppDelegate.appGroupId)
        let languages = defaults?.stringArray(forKey: "voquill_dictation_languages") ?? []
        result(languages)

      case "getActiveDictationLanguage":
        let defaults = UserDefaults(suiteName: AppDelegate.appGroupId)
        let language = defaults?.string(forKey: "voquill_dictation_language")
        result(language)

      case "setDictationLanguages":
        guard let args = call.arguments as? [String: Any],
              let languages = args["languages"] as? [String],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        defaults.set(languages, forKey: "voquill_dictation_languages")
        result(nil)

      case "setActiveDictationLanguage":
        guard let args = call.arguments as? [String: String],
              let language = args["language"],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        defaults.set(language, forKey: "voquill_dictation_language")
        result(nil)

      case "getTranscriptions":
        let defaults = UserDefaults(suiteName: AppDelegate.appGroupId)
        let transcriptions = defaults?.array(forKey: "voquill_transcriptions") as? [[String: Any]] ?? []
        result(transcriptions)

      case "getSelectedToneId":
        let defaults = UserDefaults(suiteName: AppDelegate.appGroupId)
        result(defaults?.string(forKey: "voquill_selected_tone_id"))

      case "setSelectedToneId":
        guard let args = call.arguments as? [String: String],
              let toneId = args["toneId"],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        defaults.set(toneId, forKey: "voquill_selected_tone_id")
        result(nil)

      case "getAppCounter":
        let defaults = UserDefaults(suiteName: AppDelegate.appGroupId)
        let counter = defaults?.integer(forKey: "voquill_app_update_counter") ?? 0
        result(counter)

      case "incrementKeyboardCounter":
        let defaults = UserDefaults(suiteName: AppDelegate.appGroupId)
        let counter = defaults?.integer(forKey: "voquill_keyboard_update_counter") ?? 0
        defaults?.set(counter + 1, forKey: "voquill_keyboard_update_counter")
        result(nil)

      case "isKeyboardEnabled":
        let bundleId = Bundle.main.bundleIdentifier ?? ""
        let keyboardBundleId = bundleId + ".keyboard"
        let keyboards = UserDefaults.standard.object(forKey: "AppleKeyboards") as? [String] ?? []
        result(keyboards.contains(where: { $0.hasPrefix(keyboardBundleId) }))

      case "openKeyboardSettings":
        if let url = URL(string: UIApplication.openSettingsURLString) {
          UIApplication.shared.open(url)
        }
        result(nil)

      case "setKeyboardAiConfig":
        guard let args = call.arguments as? [String: String],
              let transcriptionMode = args["transcriptionMode"],
              let postProcessingMode = args["postProcessingMode"],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        defaults.set(transcriptionMode, forKey: "voquill_ai_transcription_mode")
        defaults.set(postProcessingMode, forKey: "voquill_ai_post_processing_mode")
        if let provider = args["transcriptionProvider"] {
          defaults.set(provider, forKey: "voquill_ai_transcription_provider")
        } else {
          defaults.removeObject(forKey: "voquill_ai_transcription_provider")
        }
        if let apiKey = args["transcriptionApiKey"] {
          defaults.set(apiKey, forKey: "voquill_ai_transcription_api_key")
        } else {
          defaults.removeObject(forKey: "voquill_ai_transcription_api_key")
        }
        if let provider = args["postProcessingProvider"] {
          defaults.set(provider, forKey: "voquill_ai_post_processing_provider")
        } else {
          defaults.removeObject(forKey: "voquill_ai_post_processing_provider")
        }
        if let apiKey = args["postProcessingApiKey"] {
          defaults.set(apiKey, forKey: "voquill_ai_post_processing_api_key")
        } else {
          defaults.removeObject(forKey: "voquill_ai_post_processing_api_key")
        }
        if let baseUrl = args["transcriptionBaseUrl"] {
          defaults.set(baseUrl, forKey: "voquill_ai_transcription_base_url")
        } else {
          defaults.removeObject(forKey: "voquill_ai_transcription_base_url")
        }
        if let baseUrl = args["postProcessingBaseUrl"] {
          defaults.set(baseUrl, forKey: "voquill_ai_post_processing_base_url")
        } else {
          defaults.removeObject(forKey: "voquill_ai_post_processing_base_url")
        }
        if let model = args["transcriptionModel"] {
          defaults.set(model, forKey: "voquill_ai_transcription_model")
        } else {
          defaults.removeObject(forKey: "voquill_ai_transcription_model")
        }
        if let model = args["postProcessingModel"] {
          defaults.set(model, forKey: "voquill_ai_post_processing_model")
        } else {
          defaults.removeObject(forKey: "voquill_ai_post_processing_model")
        }
        if let azureRegion = args["transcriptionAzureRegion"] {
          defaults.set(azureRegion, forKey: "voquill_ai_transcription_azure_region")
        } else {
          defaults.removeObject(forKey: "voquill_ai_transcription_azure_region")
        }
        result(nil)

      case "setIdleTimeout":
        guard let args = call.arguments as? [String: Any],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        let timeoutSeconds: Int
        if let intVal = args["timeoutSeconds"] as? Int {
          timeoutSeconds = intVal
        } else if let doubleVal = args["timeoutSeconds"] as? Double {
          timeoutSeconds = Int(doubleVal)
        } else {
          result(FlutterError(code: "INVALID_ARGS", message: "timeoutSeconds required", details: nil))
          return
        }
        guard timeoutSeconds >= 0 else {
          result(FlutterError(code: "INVALID_ARGS", message: "timeout must be >= 0", details: nil))
          return
        }
        defaults.set(Double(timeoutSeconds), forKey: DictationConstants.idleTimeoutKey)
        DictationService.shared.restartIdleTimeoutIfActive()
        result(nil)

      case "startDictation":
        DictationService.shared.startDictation()
        result(nil)

      case "stopDictation":
        DictationService.shared.stopDictation()
        result(nil)

      case "getDictationPhase":
        result(DictationService.shared.currentPhase.rawValue)

      case "setKeyboardLayouts":
        guard let args = call.arguments as? [String: Any],
              let layouts = args["layouts"],
              let activeLanguage = args["activeLanguage"] as? String,
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["layouts": layouts, "activeLanguage": activeLanguage]) {
          defaults.set(data, forKey: "voquill_keyboard_layouts")
        }
        result(nil)

      case "setKeyboardToolbar":
        guard let args = call.arguments as? [String: Any],
              let activeMode = args["activeMode"] as? String,
              let visibleActions = args["visibleActions"],
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        if let data = try? JSONSerialization.data(withJSONObject: ["activeMode": activeMode, "visibleActions": visibleActions]) {
          defaults.set(data, forKey: "voquill_keyboard_toolbar")
        }
        result(nil)

      case "setKeyboardLanguages":
        guard let args = call.arguments as? [String: Any],
              let languages = args["languages"],
              let activeLanguage = args["activeLanguage"] as? String,
              let defaults = UserDefaults(suiteName: AppDelegate.appGroupId) else {
          result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
          return
        }
        var payload: [String: Any] = ["languages": languages, "activeLanguage": activeLanguage]
        if let meta = args["languageMetadata"] { payload["languageMetadata"] = meta }
        if let data = try? JSONSerialization.data(withJSONObject: payload) {
          defaults.set(data, forKey: "voquill_keyboard_languages")
        }
        result(nil)

      default:
        result(FlutterMethodNotImplemented)
      }
    }

    GeneratedPluginRegistrant.register(with: self)

    if let url = launchOptions?[.url] as? URL {
      handleDictationURL(url)
    }

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  override func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
    if handleDictationURL(url) {
      return true
    }
    return super.application(app, open: url, options: options)
  }

  override func applicationWillTerminate(_ application: UIApplication) {
    DictationService.shared.stopDictation()
    super.applicationWillTerminate(application)
  }

  @discardableResult
  private func handleDictationURL(_ url: URL) -> Bool {
    guard url.scheme == "voquill" else { return false }

    switch url.host {
    case "dictate":
      let wasActive = UIApplication.shared.applicationState == .active
      DictationService.shared.startDictation()
      if !wasActive {
        channel?.invokeMethod("showDictationDialog", arguments: nil)
      }
      return true
    case "stop":
      DictationService.shared.stopDictation()
      return true
    case "open":
      return true
    case "upgrade":
      channel?.invokeMethod("showPaywall", arguments: nil)
      return true
    default:
      return false
    }
  }
}
