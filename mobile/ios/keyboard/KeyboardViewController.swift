import UIKit
import AVFoundation
import Mixpanel

// MARK: - Audio Waveform

class AudioWaveformView: UIView {
    private var displayLink: CADisplayLink?
    private var phase: CGFloat = 0
    private var currentLevel: CGFloat = 0.0
    private var targetLevel: CGFloat = 0.0

    private let basePhaseStep: CGFloat = 0.18
    private let attackSmoothing: CGFloat = 0.3
    private let decaySmoothing: CGFloat = 0.12

    private struct WaveConfig {
        let frequency: CGFloat
        let multiplier: CGFloat
        let phaseOffset: CGFloat
        let opacity: CGFloat
    }

    private let waveConfigs: [WaveConfig] = [
        WaveConfig(frequency: 0.8, multiplier: 1.0, phaseOffset: 0, opacity: 1.0),
        WaveConfig(frequency: 1.0, multiplier: 0.8, phaseOffset: 0.85, opacity: 0.65),
        WaveConfig(frequency: 1.25, multiplier: 0.6, phaseOffset: 1.7, opacity: 0.35)
    ]

    var waveColor: UIColor = .label {
        didSet { setNeedsDisplay() }
    }

    var isActive: Bool = false {
        didSet { if !isActive { targetLevel = 0 } }
    }

    private let fadeLayer = CAGradientLayer()

    override init(frame: CGRect) {
        super.init(frame: frame)
        setupFade()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setupFade()
    }

    private func setupFade() {
        backgroundColor = .clear
        isOpaque = false
        fadeLayer.colors = [
            UIColor.clear.cgColor,
            UIColor.white.cgColor,
            UIColor.white.cgColor,
            UIColor.clear.cgColor
        ]
        fadeLayer.locations = [0, 0.12, 0.88, 1.0]
        fadeLayer.startPoint = CGPoint(x: 0, y: 0.5)
        fadeLayer.endPoint = CGPoint(x: 1, y: 0.5)
        layer.mask = fadeLayer
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fadeLayer.frame = bounds
        CATransaction.commit()
    }

    func startAnimating() {
        stopAnimating()
        displayLink = CADisplayLink(target: self, selector: #selector(tick))
        displayLink?.preferredFramesPerSecond = 60
        displayLink?.add(to: .main, forMode: .common)
    }

    func stopAnimating() {
        displayLink?.invalidate()
        displayLink = nil
    }

    func updateLevel(_ level: CGFloat) {
        targetLevel = level
    }

    @objc private func tick() {
        let smoothing = targetLevel > currentLevel ? attackSmoothing : decaySmoothing
        currentLevel += (targetLevel - currentLevel) * smoothing

        if isActive {
            phase += basePhaseStep + (currentLevel * 0.06)
        }
        if phase > .pi * 2 { phase -= .pi * 2 }

        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        let w = rect.width, h = rect.height, mid = h / 2

        if !isActive && currentLevel < 0.01 {
            let path = UIBezierPath()
            path.move(to: CGPoint(x: 0, y: mid))
            path.addLine(to: CGPoint(x: w, y: mid))
            ctx.saveGState()
            waveColor.setStroke()
            path.lineWidth = 2.5
            path.stroke()
            ctx.restoreGState()
            return
        }

        for cfg in waveConfigs {
            let amp = h * 0.45 * currentLevel * cfg.multiplier
            let path = UIBezierPath()
            let segments = 60

            for i in 0...segments {
                let x = CGFloat(i) / CGFloat(segments) * w
                let y = mid + amp * sin(cfg.frequency * (x / w) * .pi * 2 + phase + cfg.phaseOffset)
                if i == 0 { path.move(to: CGPoint(x: x, y: y)) }
                else { path.addLine(to: CGPoint(x: x, y: y)) }
            }

            ctx.saveGState()
            waveColor.withAlphaComponent(cfg.opacity).setStroke()
            path.lineWidth = 2.5
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            path.stroke()
            ctx.restoreGState()
        }
    }
}

// MARK: - Indeterminate Progress Bar

class IndeterminateProgressView: UIView {
    private var displayLink: CADisplayLink?
    private var time: CGFloat = 0

    var barColor: UIColor = .label

    private let fadeLayer = CAGradientLayer()
    private let cycleDuration: CGFloat = 1.8

    override init(frame: CGRect) {
        super.init(frame: frame)
        setup()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        setup()
    }

    private func setup() {
        backgroundColor = .clear
        isOpaque = false
        fadeLayer.colors = [
            UIColor.clear.cgColor,
            UIColor.white.cgColor,
            UIColor.white.cgColor,
            UIColor.clear.cgColor
        ]
        fadeLayer.locations = [0, 0.12, 0.88, 1.0]
        fadeLayer.startPoint = CGPoint(x: 0, y: 0.5)
        fadeLayer.endPoint = CGPoint(x: 1, y: 0.5)
        layer.mask = fadeLayer
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        fadeLayer.frame = bounds
        CATransaction.commit()
    }

    func startAnimating() {
        stopAnimating()
        time = 0
        displayLink = CADisplayLink(target: self, selector: #selector(tick))
        displayLink?.preferredFramesPerSecond = 60
        displayLink?.add(to: .main, forMode: .common)
    }

    func stopAnimating() {
        displayLink?.invalidate()
        displayLink = nil
    }

    private func easeInOut(_ t: CGFloat) -> CGFloat {
        if t < 0.5 {
            return 2 * t * t
        } else {
            return -1 + (4 - 2 * t) * t
        }
    }

    @objc private func tick() {
        time += 1.0 / 60.0
        if time > cycleDuration { time -= cycleDuration }
        setNeedsDisplay()
    }

    override func draw(_ rect: CGRect) {
        guard let ctx = UIGraphicsGetCurrentContext() else { return }
        let w = rect.width, h = rect.height, mid = h / 2

        let trackPath = UIBezierPath()
        trackPath.move(to: CGPoint(x: 0, y: mid))
        trackPath.addLine(to: CGPoint(x: w, y: mid))
        ctx.saveGState()
        barColor.withAlphaComponent(0.15).setStroke()
        trackPath.lineWidth = 2.5
        trackPath.lineCapStyle = .round
        trackPath.stroke()
        ctx.restoreGState()

        let t = time / cycleDuration

        let headT = easeInOut(min(t * 1.2, 1.0))
        let head = -0.1 + headT * 1.2

        let tailRaw = max((t - 0.2) / 0.8, 0)
        let tailT = easeInOut(min(tailRaw, 1.0))
        let tail = -0.1 + tailT * 1.2

        let startX = tail * w
        let endX = head * w
        let clampedStart = max(0, min(w, startX))
        let clampedEnd = max(0, min(w, endX))

        if clampedEnd > clampedStart + 1 {
            let barPath = UIBezierPath()
            barPath.move(to: CGPoint(x: clampedStart, y: mid))
            barPath.addLine(to: CGPoint(x: clampedEnd, y: mid))
            ctx.saveGState()
            barColor.setStroke()
            barPath.lineWidth = 2.5
            barPath.lineCapStyle = .round
            barPath.stroke()
            ctx.restoreGState()
        }
    }
}

// MARK: - Keyboard Controller

class KeyboardViewController: UIInputViewController {

    private enum PillVisual {
        case idle, recording, loading, error(String)
    }

    private var dictationPhase: DictationPhase = .idle
    private var isProcessing = false

    private var pillButton: UIView!
    private var pillLabel: UILabel!
    private var waveformView: AudioWaveformView!
    private var progressView: IndeterminateProgressView!
    private var nextKeyboardButton: UIButton?
    private var logoButton: UIButton!
    private var languageChip: UIButton!

    private var toneContainer: UIScrollView!
    private var toneContainerLeadingToGlobe: NSLayoutConstraint!
    private var toneContainerLeadingToView: NSLayoutConstraint!
    private var selectedToneId: String?
    private var activeToneIds: [String] = []
    private var toneById: [String: SharedTone] = [:]

    private var termIds: [String] = []
    private var termById: [String: SharedTerm] = [:]

    private var dictationLanguages: [String] = ["en"]

    private var audioLevelTimer: Timer?
    private var smoothedAudioLevel: CGFloat = 0
    private var appCounterPoller: Timer?
    private var lastAppCounter: Int = -1

    private var deleteRepeatTimer: Timer?
    private var deleteWordTimer: Timer?
    private var deleteIsWordMode = false

    private var cachedIdToken: String?
    private var cachedIdTokenExpiry: Date?
    private var lastDebugLog: String = ""

    private var memberInfo: MemberInfo?
    private var configInfo: ConfigInfo?
    private var memberRefreshTimer: Timer?
    private var statusBanner: UIView!
    private var statusIcon: UIImageView!
    private var statusLabel: UILabel!
    private var upgradeButton: UIButton!
    private var fullAccessBanner: UIView!

    override func viewDidLoad() {
        super.viewDidLoad()
        initMixpanel()
        buildUI()
        startKeyboardCounterPoller()
    }

    private func initMixpanel() {
        let defaults = UserDefaults(suiteName: DictationConstants.appGroupId)
        guard let token = defaults?.string(forKey: "voquill_mixpanel_token"),
              !token.isEmpty else { return }
        Mixpanel.initialize(token: token, trackAutomaticEvents: false)
        syncMixpanelUser()
    }

    private func syncMixpanelUser() {
        let defaults = UserDefaults(suiteName: DictationConstants.appGroupId)
        guard let uid = defaults?.string(forKey: "voquill_mixpanel_uid"),
              !uid.isEmpty else { return }
        Mixpanel.mainInstance().identify(distinctId: uid)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        syncFullAccessStatus()
        loadTones()
        loadLanguage()
        loadDictionary()
        refreshDictationState()
        startDarwinObservers()
        refreshMemberData()
        startMemberRefreshTimer()
    }

    private func syncFullAccessStatus() {
        let defaults = UserDefaults(suiteName: DictationConstants.appGroupId)
        defaults?.set(hasFullAccess, forKey: "voquill_keyboard_has_full_access")
        updateFullAccessState()
    }

    private func updateFullAccessState() {
        pillButton.isHidden = !hasFullAccess
        fullAccessBanner.isHidden = hasFullAccess
    }

    @objc private func onOpenSettingsTap() {
        openURL(UIApplication.openSettingsURLString)
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        updateColorsForAppearance()
    }

    private func updateColorsForAppearance() {
        waveformView.waveColor = .white
        progressView.barColor = .white
    }

    // MARK: - Dictation State

    private func refreshDictationState() {
        let defaults = UserDefaults(suiteName: DictationConstants.appGroupId)
        let phaseStr = defaults?.string(forKey: DictationConstants.phaseKey) ?? "idle"
        var newPhase = DictationPhase(rawValue: phaseStr) ?? .idle

        if newPhase != .idle && isHeartbeatStale(defaults) {
            NSLog("[VoquillKB] Heartbeat stale, resetting phase to idle")
            defaults?.set("idle", forKey: DictationConstants.phaseKey)
            newPhase = .idle
        }

        let oldPhase = dictationPhase
        dictationPhase = newPhase

        if isProcessing { return }

        switch newPhase {
        case .recording:
            applyPillVisual(.recording, animated: oldPhase != newPhase)
            startAudioLevelPolling()
        case .active:
            stopAudioLevelPolling()
            if oldPhase == .recording {
                handleTranscription()
            } else {
                applyPillVisual(.idle, animated: oldPhase != newPhase)
            }
        case .idle:
            stopAudioLevelPolling()
            applyPillVisual(.idle, animated: oldPhase != newPhase)
        }
    }

    private func isHeartbeatStale(_ defaults: UserDefaults?) -> Bool {
        let heartbeat = defaults?.double(forKey: DictationConstants.heartbeatKey)
        guard let heartbeat = heartbeat, heartbeat > 0 else { return true }
        let elapsed = Date().timeIntervalSince1970 - heartbeat
        return elapsed > DictationConstants.heartbeatStaleThreshold
    }

    // MARK: - Build UI

    private func buildUI() {
        view.backgroundColor = .clear

        let hc = view.heightAnchor.constraint(equalToConstant: 250)
        hc.priority = .defaultHigh
        hc.isActive = true

        logoButton = UIButton(type: .custom)
        logoButton.translatesAutoresizingMaskIntoConstraints = false
        logoButton.backgroundColor = UIColor.systemGray4
        logoButton.layer.cornerRadius = 8
        logoButton.clipsToBounds = true
        logoButton.addTarget(self, action: #selector(onLogoButtonTap), for: .touchUpInside)
        addButtonFeedback(logoButton)
        view.addSubview(logoButton)

        let logoImageView = UIImageView(image: UIImage(named: "VoquillLogo")?.withRenderingMode(.alwaysTemplate))
        logoImageView.translatesAutoresizingMaskIntoConstraints = false
        logoImageView.contentMode = .scaleAspectFit
        logoImageView.tintColor = .label
        logoImageView.isUserInteractionEnabled = false
        logoButton.addSubview(logoImageView)
        NSLayoutConstraint.activate([
            logoImageView.centerXAnchor.constraint(equalTo: logoButton.centerXAnchor),
            logoImageView.centerYAnchor.constraint(equalTo: logoButton.centerYAnchor),
            logoImageView.widthAnchor.constraint(equalToConstant: 28),
            logoImageView.heightAnchor.constraint(equalToConstant: 28),
        ])

        languageChip = UIButton(type: .system)
        languageChip.translatesAutoresizingMaskIntoConstraints = false
        languageChip.setTitle("EN", for: .normal)
        languageChip.titleLabel?.font = .systemFont(ofSize: 13, weight: .semibold)
        languageChip.setTitleColor(.label, for: .normal)
        languageChip.backgroundColor = UIColor.systemGray4
        languageChip.layer.cornerRadius = 8
        languageChip.clipsToBounds = true
        languageChip.isUserInteractionEnabled = true
        languageChip.addTarget(self, action: #selector(onLanguageChipTap), for: .touchUpInside)
        addButtonFeedback(languageChip)
        view.addSubview(languageChip)

        let btnConfig = UIImage.SymbolConfiguration(pointSize: 18, weight: .medium)
        let utilStack = UIStackView()
        utilStack.translatesAutoresizingMaskIntoConstraints = false
        utilStack.axis = .horizontal
        utilStack.spacing = 8
        view.addSubview(utilStack)

        for (index, iconName) in ["at", "space", "return.left", "delete.left"].enumerated() {
            let btn = UIButton(type: .system)
            btn.setImage(UIImage(systemName: iconName, withConfiguration: btnConfig), for: .normal)
            btn.tintColor = .label
            btn.backgroundColor = UIColor.systemGray4
            btn.layer.cornerRadius = 8
            btn.clipsToBounds = true
            btn.tag = index
            if index == 3 {
                btn.addTarget(self, action: #selector(onDeleteDown), for: .touchDown)
                btn.addTarget(self, action: #selector(onDeleteUp), for: [.touchUpInside, .touchUpOutside, .touchCancel])
            } else {
                btn.addTarget(self, action: #selector(onUtilButtonTap(_:)), for: .touchDown)
            }
            addButtonFeedback(btn)
            NSLayoutConstraint.activate([
                btn.widthAnchor.constraint(equalToConstant: 40),
                btn.heightAnchor.constraint(equalToConstant: 40)
            ])
            utilStack.addArrangedSubview(btn)
        }

        pillButton = UIView()
        pillButton.translatesAutoresizingMaskIntoConstraints = false
        pillButton.backgroundColor = UIColor(red: 0.2, green: 0.5, blue: 1.0, alpha: 1.0)
        pillButton.layer.cornerRadius = 28
        pillButton.clipsToBounds = true
        pillButton.isUserInteractionEnabled = true

        let press = UILongPressGestureRecognizer(target: self, action: #selector(onPillPress(_:)))
        press.minimumPressDuration = 0
        pillButton.addGestureRecognizer(press)

        waveformView = AudioWaveformView()
        waveformView.translatesAutoresizingMaskIntoConstraints = false
        waveformView.alpha = 0
        waveformView.isUserInteractionEnabled = false
        pillButton.addSubview(waveformView)

        progressView = IndeterminateProgressView()
        progressView.translatesAutoresizingMaskIntoConstraints = false
        progressView.alpha = 0
        progressView.isUserInteractionEnabled = false
        pillButton.addSubview(progressView)

        pillLabel = UILabel()
        pillLabel.translatesAutoresizingMaskIntoConstraints = false
        pillLabel.textColor = .white
        pillLabel.font = .systemFont(ofSize: 15, weight: .semibold)
        pillLabel.textAlignment = .center
        pillButton.addSubview(pillLabel)

        statusBanner = UIView()
        statusBanner.translatesAutoresizingMaskIntoConstraints = false
        statusBanner.isHidden = true

        statusIcon = UIImageView()
        statusIcon.translatesAutoresizingMaskIntoConstraints = false
        statusIcon.tintColor = .secondaryLabel
        statusIcon.contentMode = .scaleAspectFit
        statusBanner.addSubview(statusIcon)

        statusLabel = UILabel()
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.font = .systemFont(ofSize: 12, weight: .medium)
        statusLabel.textColor = .secondaryLabel
        statusBanner.addSubview(statusLabel)

        let dot = UILabel()
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.text = "·"
        dot.font = .systemFont(ofSize: 12, weight: .bold)
        dot.textColor = .tertiaryLabel
        statusBanner.addSubview(dot)

        upgradeButton = UIButton(type: .system)
        upgradeButton.translatesAutoresizingMaskIntoConstraints = false
        upgradeButton.setTitle("Upgrade", for: .normal)
        upgradeButton.titleLabel?.font = .systemFont(ofSize: 12, weight: .semibold)
        upgradeButton.addTarget(self, action: #selector(onUpgradeTap), for: .touchUpInside)
        statusBanner.addSubview(upgradeButton)

        NSLayoutConstraint.activate([
            statusBanner.heightAnchor.constraint(equalToConstant: 20),
            statusIcon.leadingAnchor.constraint(equalTo: statusBanner.leadingAnchor),
            statusIcon.centerYAnchor.constraint(equalTo: statusBanner.centerYAnchor),
            statusIcon.widthAnchor.constraint(equalToConstant: 14),
            statusIcon.heightAnchor.constraint(equalToConstant: 14),
            statusLabel.leadingAnchor.constraint(equalTo: statusIcon.trailingAnchor, constant: 4),
            statusLabel.centerYAnchor.constraint(equalTo: statusBanner.centerYAnchor),
            dot.leadingAnchor.constraint(equalTo: statusLabel.trailingAnchor, constant: 4),
            dot.centerYAnchor.constraint(equalTo: statusBanner.centerYAnchor),
            upgradeButton.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 4),
            upgradeButton.trailingAnchor.constraint(equalTo: statusBanner.trailingAnchor),
            upgradeButton.centerYAnchor.constraint(equalTo: statusBanner.centerYAnchor),
        ])

        let lockIcon = UIImageView(image: UIImage(systemName: "lock.fill"))
        lockIcon.translatesAutoresizingMaskIntoConstraints = false
        lockIcon.tintColor = .secondaryLabel
        lockIcon.contentMode = .scaleAspectFit

        let accessLabel = UILabel()
        accessLabel.translatesAutoresizingMaskIntoConstraints = false
        accessLabel.text = "Full Access required"
        accessLabel.font = .systemFont(ofSize: 14, weight: .medium)
        accessLabel.textColor = .label

        let labelRow = UIStackView(arrangedSubviews: [lockIcon, accessLabel])
        labelRow.axis = .horizontal
        labelRow.spacing = 6
        labelRow.alignment = .center

        NSLayoutConstraint.activate([
            lockIcon.widthAnchor.constraint(equalToConstant: 18),
            lockIcon.heightAnchor.constraint(equalToConstant: 18),
        ])

        let settingsButton = UIButton(type: .system)
        settingsButton.setTitle("Open Settings", for: .normal)
        settingsButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        settingsButton.backgroundColor = UIColor(red: 0.2, green: 0.5, blue: 1.0, alpha: 1.0)
        settingsButton.setTitleColor(.white, for: .normal)
        settingsButton.contentEdgeInsets = UIEdgeInsets(top: 0, left: 16, bottom: 0, right: 16)
        settingsButton.heightAnchor.constraint(equalToConstant: 32).isActive = true
        settingsButton.layer.cornerRadius = 16
        settingsButton.addTarget(self, action: #selector(onOpenSettingsTap), for: .touchUpInside)
        addButtonFeedback(settingsButton)

        fullAccessBanner = UIStackView(arrangedSubviews: [labelRow, settingsButton])
        (fullAccessBanner as! UIStackView).axis = .vertical
        (fullAccessBanner as! UIStackView).spacing = 8
        (fullAccessBanner as! UIStackView).alignment = .center
        fullAccessBanner.translatesAutoresizingMaskIntoConstraints = false
        fullAccessBanner.isHidden = true

        let pillStack = UIStackView(arrangedSubviews: [pillButton, fullAccessBanner, statusBanner])
        pillStack.translatesAutoresizingMaskIntoConstraints = false
        pillStack.axis = .vertical
        pillStack.alignment = .center
        pillStack.spacing = 6
        view.addSubview(pillStack)

        NSLayoutConstraint.activate([
            waveformView.leadingAnchor.constraint(equalTo: pillButton.leadingAnchor),
            waveformView.trailingAnchor.constraint(equalTo: pillButton.trailingAnchor),
            waveformView.topAnchor.constraint(equalTo: pillButton.topAnchor),
            waveformView.bottomAnchor.constraint(equalTo: pillButton.bottomAnchor),

            progressView.leadingAnchor.constraint(equalTo: pillButton.leadingAnchor, constant: 16),
            progressView.trailingAnchor.constraint(equalTo: pillButton.trailingAnchor, constant: -16),
            progressView.centerYAnchor.constraint(equalTo: pillButton.centerYAnchor),
            progressView.heightAnchor.constraint(equalToConstant: 20),

            pillLabel.centerXAnchor.constraint(equalTo: pillButton.centerXAnchor),
            pillLabel.centerYAnchor.constraint(equalTo: pillButton.centerYAnchor),
        ])

        toneContainer = UIScrollView()
        toneContainer.translatesAutoresizingMaskIntoConstraints = false
        toneContainer.showsHorizontalScrollIndicator = false
        view.addSubview(toneContainer)

        let nkb = UIButton(type: .system)
        nkb.setImage(UIImage(systemName: "globe", withConfiguration: UIImage.SymbolConfiguration(pointSize: 18)), for: .normal)
        nkb.tintColor = .label
        nkb.translatesAutoresizingMaskIntoConstraints = false
        nkb.addTarget(self, action: #selector(handleInputModeList(from:with:)), for: .allTouchEvents)
        view.addSubview(nkb)
        nextKeyboardButton = nkb

        let topSpacer = UIView()
        topSpacer.translatesAutoresizingMaskIntoConstraints = false
        topSpacer.isHidden = true
        view.addSubview(topSpacer)

        let bottomSpacer = UIView()
        bottomSpacer.translatesAutoresizingMaskIntoConstraints = false
        bottomSpacer.isHidden = true
        view.addSubview(bottomSpacer)

        toneContainerLeadingToGlobe = toneContainer.leadingAnchor.constraint(equalTo: nkb.trailingAnchor, constant: 4)
        toneContainerLeadingToView = toneContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16)

        NSLayoutConstraint.activate([
            logoButton.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
            logoButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 12),
            logoButton.heightAnchor.constraint(equalToConstant: 40),
            logoButton.widthAnchor.constraint(equalToConstant: 40),

            languageChip.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
            languageChip.leadingAnchor.constraint(equalTo: logoButton.trailingAnchor, constant: 8),
            languageChip.heightAnchor.constraint(equalToConstant: 40),
            languageChip.widthAnchor.constraint(greaterThanOrEqualToConstant: 40),

            utilStack.topAnchor.constraint(equalTo: view.topAnchor, constant: 8),
            utilStack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -12),

            topSpacer.topAnchor.constraint(equalTo: utilStack.bottomAnchor),
            topSpacer.bottomAnchor.constraint(equalTo: pillStack.topAnchor),
            topSpacer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            topSpacer.widthAnchor.constraint(equalToConstant: 0),

            bottomSpacer.topAnchor.constraint(equalTo: pillStack.bottomAnchor),
            bottomSpacer.bottomAnchor.constraint(equalTo: toneContainer.topAnchor),
            bottomSpacer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bottomSpacer.widthAnchor.constraint(equalToConstant: 0),

            topSpacer.heightAnchor.constraint(equalTo: bottomSpacer.heightAnchor),

            pillStack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            pillButton.widthAnchor.constraint(equalToConstant: 220),
            pillButton.heightAnchor.constraint(equalToConstant: 56),

            toneContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
            toneContainer.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -8),
            toneContainer.heightAnchor.constraint(equalToConstant: 32),

            nkb.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 8),
            nkb.centerYAnchor.constraint(equalTo: toneContainer.centerYAnchor),
            nkb.widthAnchor.constraint(equalToConstant: 36),
            nkb.heightAnchor.constraint(equalToConstant: 36),
        ])

        waveformView.startAnimating()
        updateColorsForAppearance()
    }

    private func applyPillVisual(_ visual: PillVisual, animated: Bool) {
        let changes: () -> Void
        switch visual {
        case .idle:
            changes = {
                self.waveformView.alpha = 0
                self.waveformView.isActive = false
                self.progressView.alpha = 0
                self.pillButton.backgroundColor = UIColor(red: 0.2, green: 0.5, blue: 1.0, alpha: 1.0)
                self.pillLabel.text = self.dictationPhase == .idle ? "Activate Voquill" : "Tap to dictate"
                self.pillLabel.alpha = 1
                self.pillButton.isUserInteractionEnabled = true
            }
            progressView.stopAnimating()

        case .recording:
            changes = {
                self.waveformView.alpha = 1
                self.waveformView.isActive = true
                self.progressView.alpha = 0
                self.pillButton.backgroundColor = UIColor(red: 0.2, green: 0.5, blue: 1.0, alpha: 1.0)
                self.pillLabel.alpha = 0
                self.pillButton.isUserInteractionEnabled = true
            }
            progressView.stopAnimating()

        case .loading:
            changes = {
                self.waveformView.alpha = 0
                self.waveformView.isActive = false
                self.progressView.alpha = 1
                self.pillButton.backgroundColor = UIColor.systemGray3
                self.pillLabel.text = "Processing..."
                self.pillLabel.alpha = 0
                self.pillButton.isUserInteractionEnabled = false
            }
            progressView.startAnimating()

        case .error(let message):
            changes = {
                self.waveformView.alpha = 0
                self.waveformView.isActive = false
                self.progressView.alpha = 0
                self.pillButton.backgroundColor = UIColor.systemRed
                self.pillLabel.text = message
                self.pillLabel.alpha = 1
                self.pillButton.isUserInteractionEnabled = true
            }
            progressView.stopAnimating()
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                self?.applyPillVisual(.idle, animated: true)
            }
        }

        if animated {
            UIView.animate(withDuration: 0.15, delay: 0, options: .curveEaseInOut, animations: changes)
        } else {
            changes()
        }
    }

    // MARK: - Actions

    @objc private func onPillPress(_ gesture: UILongPressGestureRecognizer) {
        switch gesture.state {
        case .began:
            UIView.animate(withDuration: 0.1, delay: 0, options: .curveEaseInOut) {
                self.pillButton.transform = CGAffineTransform(scaleX: 0.95, y: 0.95)
            }
        case .ended:
            UIView.animate(withDuration: 0.15, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0, options: []) {
                self.pillButton.transform = .identity
            }
            let location = gesture.location(in: pillButton)
            if pillButton.bounds.contains(location) {
                switch dictationPhase {
                case .idle:
                    Mixpanel.mainInstance().track(event: "Activate Dictation Mode")
                    openURL("voquill://dictate")
                case .active:
                    DarwinNotificationManager.shared.post(DictationConstants.startRecording)
                case .recording:
                    DarwinNotificationManager.shared.post(DictationConstants.stopRecording)
                }
            }
        case .cancelled, .failed:
            UIView.animate(withDuration: 0.15, delay: 0, options: .curveEaseInOut) {
                self.pillButton.transform = .identity
            }
        default: break
        }
    }

    private func addButtonFeedback(_ button: UIButton) {
        button.addTarget(self, action: #selector(onButtonDown(_:)), for: .touchDown)
        button.addTarget(self, action: #selector(onButtonUp(_:)), for: [.touchUpInside, .touchUpOutside, .touchCancel])
    }

    @objc private func onButtonDown(_ sender: UIButton) {
        UIView.animate(withDuration: 0.1, delay: 0, options: [.curveEaseInOut, .allowUserInteraction, .beginFromCurrentState]) {
            sender.transform = CGAffineTransform(scaleX: 0.9, y: 0.9)
        }
    }

    @objc private func onButtonUp(_ sender: UIButton) {
        UIView.animate(withDuration: 0.15, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
            sender.transform = .identity
        }
    }


    private func openURL(_ urlString: String) {
        guard let url = URL(string: urlString) else { return }
        var responder: UIResponder? = self
        while let r = responder {
            if let application = r as? UIApplication {
                application.open(url, options: [:], completionHandler: nil)
                return
            }
            responder = r.next
        }

        let selector = NSSelectorFromString("openURL:")
        responder = self
        while let r = responder {
            if r.responds(to: selector) {
                r.perform(selector, with: url)
                return
            }
            responder = r.next
        }
    }

    // MARK: - Keyboard Counter Polling

    private func startKeyboardCounterPoller() {
        appCounterPoller = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.checkKeyboardCounter()
        }
    }

    private func checkKeyboardCounter() {
        let counter = CounterRepo().getKeyboard()
        if counter != lastAppCounter {
            lastAppCounter = counter
            loadTones()
            loadLanguage()
            loadDictionary()
            syncMixpanelUser()
            updateStatusBanner()
        }

        if dictationPhase != .idle {
            refreshDictationState()
        }
    }

    // MARK: - Dictionary

    private func loadDictionary() {
        guard let defaults = UserDefaults(suiteName: DictationConstants.appGroupId) else { return }
        let loaded = SharedTerm.loadFromDefaults(defaults)
        termIds = loaded.termIds
        termById = loaded.termById
    }

    // MARK: - Language Chip

    private func loadLanguage() {
        let defaults = UserDefaults(suiteName: DictationConstants.appGroupId)
        let language = defaults?.string(forKey: "voquill_dictation_language") ?? "en"
        dictationLanguages = defaults?.stringArray(forKey: "voquill_dictation_languages") ?? ["en"]
        let code = language.components(separatedBy: "-").first ?? language
        languageChip.setTitle(code.uppercased(), for: .normal)
        languageChip.isHidden = dictationLanguages.count <= 1
    }

    @objc private func onLogoButtonTap() {
        openURL("voquill://open")
    }

    @objc private func onLanguageChipTap() {
        guard !dictationLanguages.isEmpty else { return }
        let defaults = UserDefaults(suiteName: DictationConstants.appGroupId)
        let current = defaults?.string(forKey: "voquill_dictation_language") ?? "en"
        let currentIndex = dictationLanguages.firstIndex(of: current) ?? 0
        let nextIndex = (currentIndex + 1) % dictationLanguages.count
        let next = dictationLanguages[nextIndex]

        defaults?.set(next, forKey: "voquill_dictation_language")
        let code = next.components(separatedBy: "-").first ?? next
        languageChip.setTitle(code.uppercased(), for: .normal)

        CounterRepo().incrementApp()
    }

    // MARK: - Tone Selector

    private func loadTones() {
        let defaults = UserDefaults(suiteName: DictationConstants.appGroupId)
        let toneData = defaults.flatMap { SharedTone.loadFromDefaults($0) }
        activeToneIds = toneData?.activeToneIds ?? []
        toneById = toneData?.toneById ?? [:]
        selectedToneId = defaults?.string(forKey: "voquill_selected_tone_id") ?? activeToneIds.first
        renderToneChips()
    }

    private func renderToneChips() {
        toneContainer.subviews.forEach { $0.removeFromSuperview() }

        if activeToneIds.isEmpty || toneById.isEmpty {
            let label = UILabel()
            label.text = "No tones available"
            label.font = .systemFont(ofSize: 13, weight: .medium)
            label.textColor = .secondaryLabel
            label.sizeToFit()
            label.frame.origin = .zero
            toneContainer.addSubview(label)
            toneContainer.contentSize = label.frame.size
            return
        }

        var xOffset: CGFloat = 0
        for (index, toneId) in activeToneIds.enumerated() {
            guard let tone = toneById[toneId] else { continue }
            let chip = UIButton(type: .system)
            chip.setTitle(tone.name, for: .normal)
            chip.titleLabel?.font = .systemFont(ofSize: 13, weight: .medium)
            chip.contentEdgeInsets = UIEdgeInsets(top: 6, left: 14, bottom: 6, right: 14)
            chip.layer.cornerRadius = 16
            chip.clipsToBounds = true
            chip.tag = index
            chip.addTarget(self, action: #selector(onToneChipTap(_:)), for: .touchUpInside)
            addButtonFeedback(chip)
            applyChipStyle(chip, selected: toneId == selectedToneId)
            chip.sizeToFit()
            chip.frame = CGRect(x: xOffset, y: 0, width: chip.frame.width, height: 32)
            toneContainer.addSubview(chip)
            xOffset += chip.frame.width + 8
        }
        toneContainer.contentSize = CGSize(width: max(0, xOffset - 8), height: 32)
    }

    private func centerToneContent() {
        let containerWidth = toneContainer.bounds.width
        let contentWidth = toneContainer.contentSize.width
        if contentWidth < containerWidth {
            let inset = (containerWidth - contentWidth) / 2
            toneContainer.contentInset = UIEdgeInsets(top: 0, left: inset, bottom: 0, right: inset)
        } else {
            toneContainer.contentInset = .zero
        }
    }

    private func applyChipStyle(_ chip: UIButton, selected: Bool) {
        if selected {
            chip.backgroundColor = UIColor(red: 0.2, green: 0.5, blue: 1.0, alpha: 0.2)
            chip.setTitleColor(.systemBlue, for: .normal)
        } else {
            chip.backgroundColor = UIColor.systemGray4
            chip.setTitleColor(.label, for: .normal)
        }
    }

    @objc private func onToneChipTap(_ sender: UIButton) {
        let index = sender.tag
        guard index < activeToneIds.count else { return }
        selectedToneId = activeToneIds[index]

        if let defaults = UserDefaults(suiteName: DictationConstants.appGroupId) {
            defaults.set(selectedToneId, forKey: "voquill_selected_tone_id")
        }

        for view in toneContainer.subviews {
            guard let chip = view as? UIButton else { continue }
            applyChipStyle(chip, selected: chip.tag == index)
        }
    }

    // MARK: - Member Status

    private func startMemberRefreshTimer() {
        memberRefreshTimer?.invalidate()
        memberRefreshTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { [weak self] _ in
            self?.refreshMemberData()
        }
    }

    private func refreshMemberData() {
        fetchIdToken { [weak self] idToken in
            guard let self = self, let idToken = idToken else { return }
            guard let defaults = UserDefaults(suiteName: DictationConstants.appGroupId),
                  let functionUrl = defaults.string(forKey: "voquill_function_url") else { return }

            let config = RepoConfig(functionUrl: functionUrl, idToken: idToken)
            let repo = MemberRepo(config: config)

            Task {
                do {
                    async let memberResult = repo.getMyMember()
                    async let configResult = repo.getFullConfig()
                    let (member, cfg) = try await (memberResult, configResult)

                    await MainActor.run {
                        self.memberInfo = member
                        if let cfg = cfg { self.configInfo = cfg }
                        self.updateStatusBanner()
                    }
                } catch {
                    NSLog("[VoquillKB] Failed to refresh member: %@", error.localizedDescription)
                }
            }
        }
    }

    private func updateStatusBanner() {
        if let defaults = UserDefaults(suiteName: DictationConstants.appGroupId) {
            let transcriptionMode = defaults.string(forKey: "voquill_ai_transcription_mode") ?? "cloud"
            let postProcessingMode = defaults.string(forKey: "voquill_ai_post_processing_mode") ?? "cloud"
            if transcriptionMode == "api" && postProcessingMode == "api" {
                setStatusBannerVisible(false)
                return
            }
        }

        guard let member = memberInfo else {
            setStatusBannerVisible(false)
            return
        }

        if member.isOnTrial {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let trialEndsAt = member.trialEndsAt,
                let endDate = formatter.date(from: trialEndsAt) {
                let secondsRemaining = endDate.timeIntervalSince(Date())
                let daysLeft = max(0, Int(ceil(secondsRemaining / 86400)))
                let text = daysLeft == 0 ? "Last day of trial" :
                           daysLeft == 1 ? "1 day left in trial" :
                           "\(daysLeft) days left in trial"
                statusIcon.image = UIImage(systemName: "hourglass.bottomhalf.filled")
                statusLabel.text = text
                setStatusBannerVisible(true)
            } else {
                statusIcon.image = UIImage(systemName: "hourglass.bottomhalf.filled")
                statusLabel.text = "Your trial ends soon"
                setStatusBannerVisible(true)
            }
        } else if member.plan == "free" {
            if let config = configInfo {
                let remaining = max(0, config.freeWordsPerWeek - member.wordsThisWeek)
                let formatter = NumberFormatter()
                formatter.numberStyle = .decimal
                let formatted = formatter.string(from: NSNumber(value: remaining)) ?? "\(remaining)"
                statusIcon.image = UIImage(systemName: "pencil.line")
                statusLabel.text = "\(formatted) words left"
                setStatusBannerVisible(true)
            } else {
                statusIcon.image = UIImage(systemName: "pencil.line")
                statusLabel.text = "Free plan"
                setStatusBannerVisible(true)
            }
        } else {
            setStatusBannerVisible(false)
        }
    }

    private func setStatusBannerVisible(_ visible: Bool) {
        let alreadyVisible = !statusBanner.isHidden
        guard visible != alreadyVisible else { return }

        if visible {
            statusBanner.alpha = 0
            statusBanner.isHidden = false
        }

        UIView.animate(withDuration: 0.3, delay: 0, options: .curveEaseInOut) {
            self.statusBanner.alpha = visible ? 1 : 0
            self.view.layoutIfNeeded()
        } completion: { _ in
            if !visible {
                self.statusBanner.isHidden = true
            }
        }
    }

    @objc private func onUpgradeTap() {
        Mixpanel.mainInstance().track(event: "Button Click", properties: ["name": "upgrade keyboard"])
        openURL("voquill://upgrade")
    }

    @objc private func onUtilButtonTap(_ sender: UIButton) {
        switch sender.tag {
        case 0: textDocumentProxy.insertText("@")
        case 1: textDocumentProxy.insertText(" ")
        case 2: textDocumentProxy.insertText("\n")
        default: break
        }
    }

    @objc private func onDeleteDown() {
        textDocumentProxy.deleteBackward()
        deleteIsWordMode = false
        deleteRepeatTimer?.invalidate()
        deleteWordTimer?.invalidate()

        deleteRepeatTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            self.deleteRepeatTimer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                if self.deleteIsWordMode {
                    self.deleteWord()
                } else {
                    self.textDocumentProxy.deleteBackward()
                }
            }
        }

        deleteWordTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: false) { [weak self] _ in
            self?.deleteIsWordMode = true
        }
    }

    @objc private func onDeleteUp() {
        deleteRepeatTimer?.invalidate()
        deleteRepeatTimer = nil
        deleteWordTimer?.invalidate()
        deleteWordTimer = nil
        deleteIsWordMode = false
    }

    private func deleteWord() {
        guard let text = textDocumentProxy.documentContextBeforeInput, !text.isEmpty else {
            textDocumentProxy.deleteBackward()
            return
        }
        let trimmed = text.hasSuffix(" ") ? String(text.dropLast()) : text
        if let lastSpace = trimmed.lastIndex(of: " ") {
            let count = text.distance(from: lastSpace, to: text.endIndex)
            for _ in 0..<count {
                textDocumentProxy.deleteBackward()
            }
        } else {
            for _ in 0..<text.count {
                textDocumentProxy.deleteBackward()
            }
        }
    }

    // MARK: - Transcription

    private func dbg(_ msg: String) {
        NSLog("[VoquillKB] %@", msg)
        lastDebugLog = msg
    }

    private func buildTranscribeRepo(defaults: UserDefaults, config: RepoConfig?) -> BaseTranscribeAudioRepo? {
        let mode = defaults.string(forKey: "voquill_ai_transcription_mode") ?? "cloud"
        if mode == "api",
           let provider = defaults.string(forKey: "voquill_ai_transcription_provider"),
           let apiKey = defaults.string(forKey: "voquill_ai_transcription_api_key") {
            let baseUrl = defaults.string(forKey: "voquill_ai_transcription_base_url")
            let model = defaults.string(forKey: "voquill_ai_transcription_model")
            let azureRegion = defaults.string(forKey: "voquill_ai_transcription_azure_region")
            return ByokTranscribeAudioRepo(apiKey: apiKey, provider: provider, baseUrl: baseUrl, modelOverride: model, azureRegion: azureRegion)
        }
        guard let config = config else { return nil }
        return CloudTranscribeAudioRepo(config: config)
    }

    private func buildGenerateTextRepo(defaults: UserDefaults, config: RepoConfig?) -> BaseGenerateTextRepo? {
        let mode = defaults.string(forKey: "voquill_ai_post_processing_mode") ?? "cloud"
        if mode == "api",
           let provider = defaults.string(forKey: "voquill_ai_post_processing_provider"),
           let apiKey = defaults.string(forKey: "voquill_ai_post_processing_api_key") {
            let baseUrl = defaults.string(forKey: "voquill_ai_post_processing_base_url")
            let model = defaults.string(forKey: "voquill_ai_post_processing_model")
            return ByokGenerateTextRepo(apiKey: apiKey, provider: provider, baseUrl: baseUrl, modelOverride: model)
        }
        guard let config = config else { return nil }
        return CloudGenerateTextRepo(config: config)
    }

    private func handleTranscription() {
        guard hasFullAccess else {
            DispatchQueue.main.async {
                self.applyPillVisual(.error("Enable Full Access in Settings"), animated: true)
            }
            return
        }

        let capturedToneId = selectedToneId
        let capturedToneById = toneById

        isProcessing = true
        applyPillVisual(.loading, animated: true)

        guard let defaults = UserDefaults(suiteName: DictationConstants.appGroupId) else {
            DispatchQueue.main.async {
                self.isProcessing = false
                self.applyPillVisual(.error("Setup error — please reinstall"), animated: true)
            }
            return
        }

        guard let audioUrl = DictationConstants.audioFileURL else {
            DispatchQueue.main.async {
                self.isProcessing = false
                self.applyPillVisual(.error("Recording error — try again"), animated: true)
            }
            return
        }

        let transcriptionMode = defaults.string(forKey: "voquill_ai_transcription_mode") ?? "cloud"
        let postProcessingMode = defaults.string(forKey: "voquill_ai_post_processing_mode") ?? "cloud"
        let needsCloudAuth = transcriptionMode == "cloud" || postProcessingMode == "cloud"

        let continueWithConfig: (RepoConfig?) -> Void = { [weak self] config in
            guard let self = self else { return }

            guard let transcribeRepo = self.buildTranscribeRepo(defaults: defaults, config: config) else {
                DispatchQueue.main.async {
                    self.isProcessing = false
                    self.applyPillVisual(.error("Transcription not configured"), animated: true)
                }
                return
            }

            let dictationLanguage = defaults.string(forKey: "voquill_dictation_language") ?? "en"
            let userName = defaults.string(forKey: "voquill_user_name") ?? "User"
            let prompt = buildLocalizedTranscriptionPrompt(
                termIds: self.termIds,
                termById: self.termById,
                userName: userName,
                language: dictationLanguage
            )
            let whisperLanguage = mapDictationLanguageToWhisperLanguage(dictationLanguage)

            Task {
                do {
                    let rawTranscript = try await transcribeRepo.transcribe(
                        audioFileURL: audioUrl,
                        prompt: prompt,
                        language: whisperLanguage
                    )

                    guard !rawTranscript.isEmpty else {
                        await MainActor.run {
                            self.isProcessing = false
                            self.applyPillVisual(.idle, animated: true)
                        }
                        return
                    }

                    var finalText = rawTranscript
                    do {
                        if let tone = capturedToneId.flatMap({ capturedToneById[$0] }) {
                            if let generateRepo = self.buildGenerateTextRepo(defaults: defaults, config: config) {
                                let raw = try await generateRepo.generate(
                                    system: buildSystemPostProcessingPrompt(),
                                    prompt: buildPostProcessingPrompt(
                                        transcript: rawTranscript,
                                        tonePromptTemplate: tone.promptTemplate,
                                        termIds: self.termIds,
                                        termById: self.termById
                                    ),
                                    jsonResponse: postProcessingJsonResponse
                                )
                                if let processed = extractPostProcessingResult(from: raw) {
                                    finalText = processed.trimmingCharacters(in: .whitespacesAndNewlines)
                                } else {
                                    self.dbg("Could not parse result from post-processing JSON, using raw")
                                    finalText = raw
                                }
                            }
                        }
                    } catch {
                        self.dbg("Post-processing failed, using raw transcript: \(error.localizedDescription)")
                    }

                    if let config = config {
                        let tz = TimeZone.current.identifier
                        UserRepo(config: config).incrementWordCount(text: finalText, timezone: tz)
                    }

                    let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines) + " "
                    await MainActor.run {
                        self.textDocumentProxy.insertText(trimmed)
                        self.isProcessing = false
                        self.applyPillVisual(.idle, animated: true)
                        self.refreshMemberData()
                    }

                    let tone = capturedToneId.flatMap { capturedToneById[$0] }
                    TranscriptionRepo().save(
                        text: finalText,
                        rawTranscript: rawTranscript,
                        toneId: capturedToneId,
                        toneName: tone?.name,
                        audioSourceUrl: audioUrl
                    )
                } catch {
                    self.dbg("Transcription failed: \(error.localizedDescription)")
                    await MainActor.run {
                        self.isProcessing = false
                        self.applyPillVisual(.error("Transcription failed — try again"), animated: true)
                    }
                }
            }
        }

        if needsCloudAuth {
            fetchIdToken { [weak self] idToken in
                guard let self = self else { return }
                guard let idToken = idToken else {
                    DispatchQueue.main.async {
                        self.isProcessing = false
                        self.applyPillVisual(.error("Sign in required — open Voquill"), animated: true)
                    }
                    return
                }
                guard let functionUrl = defaults.string(forKey: "voquill_function_url") else {
                    DispatchQueue.main.async {
                        self.isProcessing = false
                        self.applyPillVisual(.error("Setup error — open Voquill"), animated: true)
                    }
                    return
                }
                continueWithConfig(RepoConfig(functionUrl: functionUrl, idToken: idToken))
            }
        } else {
            continueWithConfig(nil)
        }
    }

    // MARK: - Authentication

    private func fetchIdToken(completion: @escaping (String?) -> Void) {
        if let token = cachedIdToken, let expiry = cachedIdTokenExpiry, Date() < expiry {
            completion(token)
            return
        }

        guard let defaults = UserDefaults(suiteName: DictationConstants.appGroupId) else {
            dbg("UserDefaults not accessible")
            completion(nil)
            return
        }

        let apiRefreshToken = defaults.string(forKey: "voquill_api_refresh_token")
        let functionUrl = defaults.string(forKey: "voquill_function_url")
        let apiKey = defaults.string(forKey: "voquill_api_key")
        let authUrl = defaults.string(forKey: "voquill_auth_url")

        guard let apiRefreshToken = apiRefreshToken,
              let functionUrl = functionUrl,
              let apiKey = apiKey,
              let authUrl = authUrl else {
            dbg("Missing auth keys in UserDefaults")
            completion(nil)
            return
        }

        refreshApiToken(functionUrl: functionUrl, apiRefreshToken: apiRefreshToken) { [weak self] customToken in
            guard let self = self, let customToken = customToken else {
                completion(nil)
                return
            }
            self.exchangeCustomToken(authUrl: authUrl, apiKey: apiKey, customToken: customToken) { [weak self] idToken, expiresIn in
                guard let self = self, let idToken = idToken, let expiresIn = expiresIn else {
                    completion(nil)
                    return
                }
                self.cachedIdToken = idToken
                self.cachedIdTokenExpiry = Date().addingTimeInterval(expiresIn - 300)
                completion(idToken)
            }
        }
    }

    private func refreshApiToken(functionUrl: String, apiRefreshToken: String, completion: @escaping (String?) -> Void) {
        guard let url = URL(string: functionUrl) else {
            dbg("refreshApiToken: invalid URL")
            completion(nil)
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let payload: [String: Any] = [
            "data": [
                "name": "auth/refreshApiToken",
                "args": ["apiRefreshToken": apiRefreshToken]
            ]
        ]
        request.httpBody = try? JSONSerialization.data(withJSONObject: payload)

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if let error = error {
                self?.dbg("refreshApiToken: \(error.localizedDescription)")
                completion(nil)
                return
            }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let result = json["result"] as? [String: Any],
                  let apiToken = result["apiToken"] as? String else {
                self?.dbg("refreshApiToken: unexpected response")
                completion(nil)
                return
            }
            completion(apiToken)
        }.resume()
    }

    private func exchangeCustomToken(authUrl: String, apiKey: String, customToken: String, completion: @escaping (String?, TimeInterval?) -> Void) {
        let urlString = "\(authUrl)/v1/accounts:signInWithCustomToken?key=\(apiKey)"
        guard let url = URL(string: urlString) else {
            dbg("exchangeCustomToken: invalid URL")
            completion(nil, nil)
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = ["token": customToken, "returnSecureToken": true]
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            if let error = error {
                self?.dbg("exchangeCustomToken: \(error.localizedDescription)")
                completion(nil, nil)
                return
            }
            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let idToken = json["idToken"] as? String,
                  let expiresInStr = json["expiresIn"] as? String,
                  let expiresIn = TimeInterval(expiresInStr) else {
                self?.dbg("exchangeCustomToken: unexpected response")
                completion(nil, nil)
                return
            }
            completion(idToken, expiresIn)
        }.resume()
    }

    // MARK: - Audio Level Polling

    private func startAudioLevelPolling() {
        stopAudioLevelPolling()
        smoothedAudioLevel = 0
        audioLevelTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            let defaults = UserDefaults(suiteName: DictationConstants.appGroupId)
            let raw = CGFloat(defaults?.float(forKey: DictationConstants.audioLevelKey) ?? 0)
            self.smoothedAudioLevel += (raw - self.smoothedAudioLevel) * 0.3
            self.waveformView?.updateLevel(self.smoothedAudioLevel)
        }
    }

    private func stopAudioLevelPolling() {
        audioLevelTimer?.invalidate()
        audioLevelTimer = nil
    }

    // MARK: - Darwin Notification Observers

    private func startDarwinObservers() {
        DarwinNotificationManager.shared.observe(DictationConstants.dictationPhaseChanged) { [weak self] in
            self?.handlePhaseChange()
        }
    }

    private func handlePhaseChange() {
        refreshDictationState()
    }

    // MARK: - System

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        let showGlobe = needsInputModeSwitchKey
        nextKeyboardButton?.isHidden = !showGlobe
        toneContainerLeadingToGlobe.isActive = showGlobe
        toneContainerLeadingToView.isActive = !showGlobe
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        centerToneContent()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        appCounterPoller?.invalidate()
        appCounterPoller = nil
        memberRefreshTimer?.invalidate()
        memberRefreshTimer = nil
        onDeleteUp()
        DarwinNotificationManager.shared.removeObserver(DictationConstants.dictationPhaseChanged)
        stopAudioLevelPolling()
        waveformView.stopAnimating()
        progressView.stopAnimating()
    }

    override func textWillChange(_ textInput: UITextInput?) {}
    override func textDidChange(_ textInput: UITextInput?) {}
}
