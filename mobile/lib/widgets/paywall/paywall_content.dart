import 'package:app/utils/analytics_utils.dart';
import 'package:app/actions/revenue_cat_actions.dart';
import 'package:app/flavor.dart';
import 'package:app/theme/app_colors.dart';
import 'package:app/utils/color_utils.dart';
import 'package:app/utils/log_utils.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/common/app_overlay.dart';
import 'package:app/widgets/common/plan_card.dart';
import 'package:app/widgets/paywall/hero_graphic.dart';
import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:gap/gap.dart';
import 'package:purchases_flutter/purchases_flutter.dart';
import 'package:url_launcher/url_launcher.dart';

final _logger = createNamedLogger('paywall');

enum _PlanOption { yearly, monthly }

class PaywallContent extends StatefulWidget {
  const PaywallContent({super.key});

  @override
  State<PaywallContent> createState() => _PaywallContentState();
}

class _PaywallContentState extends State<PaywallContent>
    with WidgetsBindingObserver {
  _PlanOption _selected = _PlanOption.yearly;
  bool _loading = false;
  bool _loaded = false;
  Package? _yearlyPackage;
  Package? _monthlyPackage;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _loadOfferings();
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.inactive && mounted && !_loading) {
      dismissAppOverlay();
    }
  }

  Future<void> _loadOfferings() async {
    try {
      final offerings = await Purchases.getOfferings();
      final current = offerings.current;
      if (current == null || !mounted) return;
      setState(() {
        _yearlyPackage = current.annual;
        _monthlyPackage = current.monthly;
        _loaded = true;
      });
    } catch (e) {
      _logger.w('Failed to load offerings', e);
      if (mounted) setState(() => _loaded = true);
    }
  }

  String? get _savingsBadge {
    final monthly = _monthlyPackage?.storeProduct.price;
    final yearly = _yearlyPackage?.storeProduct.price;
    if (monthly == null || yearly == null || monthly == 0) return null;
    final pct = ((monthly * 12 - yearly) / (monthly * 12) * 100).round();
    if (pct <= 0) return null;
    return 'SAVE $pct%';
  }

  String? get _yearlyPerMonth {
    final yearly = _yearlyPackage?.storeProduct.price;
    final symbol = _yearlyPackage?.storeProduct.currencyCode;
    if (yearly == null || symbol == null) return null;
    final perMonth = (yearly / 12).toStringAsFixed(2);
    return '$symbol $perMonth/mo';
  }

  List<Widget> _buildFeatures() {
    const features = [
      'Unlimited words',
      'Advanced AI post-processing',
      'Custom tones and styles',
      'Priority support',
    ];
    return features.asMap().entries.map((entry) {
      final delay = 300 + entry.key * 60;
      return _FeatureItem(label: entry.value)
          .animate()
          .fadeIn(delay: delay.ms, duration: 400.ms)
          .slideX(
            begin: -0.05,
            end: 0,
            duration: 600.ms,
            curve: Curves.easeOutCubic,
          );
    }).toList();
  }

  Future<void> _onContinue() async {
    final package = _selected == _PlanOption.yearly
        ? _yearlyPackage
        : _monthlyPackage;
    if (package == null) return;

    setState(() => _loading = true);
    try {
      await Purchases.purchase(PurchaseParams.package(package));
      trackPaymentComplete();
      await refreshMemberUntilChange();
      if (mounted) dismissAppOverlay();
    } on PurchasesErrorCode {
      // User cancelled or store error
    } catch (e) {
      _logger.w('Purchase failed', e);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;
    final mq = MediaQuery.of(context);

    return Scaffold(
      backgroundColor: colors.level0,
      body: Column(
        children: [
          Expanded(
            child: CustomScrollView(
              physics: const BouncingScrollPhysics(),
              slivers: [
                SliverAppBar(
                  expandedHeight: mq.padding.top + 90,
                  pinned: false,
                  floating: false,
                  automaticallyImplyLeading: false,
                  stretch: true,
                  backgroundColor: colors.level1,
                  flexibleSpace: FlexibleSpaceBar(
                    stretchModes: const [StretchMode.zoomBackground],
                    background: Container(
                      color: colors.level1,
                      child: const HeroGraphic(),
                    ),
                  ),
                  actions: [
                    IconButton(
                      onPressed: () => dismissAppOverlay(),
                      style: IconButton.styleFrom(
                        backgroundColor: colors.level0.withApproxOpacity(0.6),
                      ),
                      icon: const Icon(Icons.close),
                    ),
                    const SizedBox(width: 4),
                  ],
                ),
                if (_loaded)
                  SliverToBoxAdapter(
                    child: Padding(
                      padding: Theming.padding,
                      child: Column(
                        children: [
                          const Gap(16),
                          Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 12,
                                  vertical: 4,
                                ),
                                decoration: BoxDecoration(
                                  color: colors.blue.withAlpha(26),
                                  borderRadius: BorderRadius.circular(20),
                                ),
                                child: Text(
                                  'PRO',
                                  style: theme.textTheme.labelSmall?.copyWith(
                                    color: colors.blue,
                                    fontWeight: FontWeight.w800,
                                    letterSpacing: 1.2,
                                  ),
                                ),
                              )
                              .animate()
                              .fadeIn(duration: 300.ms)
                              .scale(
                                begin: const Offset(0.5, 0.5),
                                end: const Offset(1, 1),
                                duration: 500.ms,
                                curve: Curves.elasticOut,
                              ),
                          const Gap(14),
                          Text(
                                'Unlimited voice typing, everywhere.',
                                style: theme.textTheme.headlineMedium?.copyWith(
                                  fontWeight: FontWeight.w900,
                                  height: 1.15,
                                ),
                                textAlign: TextAlign.center,
                              )
                              .animate()
                              .fadeIn(
                                delay: 80.ms,
                                duration: 600.ms,
                                curve: Curves.easeOut,
                              )
                              .slideY(
                                begin: 0.15,
                                end: 0,
                                duration: 700.ms,
                                curve: Curves.easeOutCubic,
                              ),
                          const Gap(24),
                          ..._buildFeatures(),
                          const Gap(32),
                          Row(
                                children: [
                                  Expanded(
                                    child: PlanCard(
                                      label: 'Yearly',
                                      price:
                                          _yearlyPackage
                                              ?.storeProduct
                                              .priceString ??
                                          '—',
                                      subtitle: _yearlyPerMonth ?? '',
                                      badgeText: _savingsBadge,
                                      selected: _selected == _PlanOption.yearly,
                                      onTap: () => setState(
                                        () => _selected = _PlanOption.yearly,
                                      ),
                                    ),
                                  ),
                                  const Gap(12),
                                  Expanded(
                                    child: PlanCard(
                                      label: 'Monthly',
                                      price:
                                          _monthlyPackage
                                              ?.storeProduct
                                              .priceString ??
                                          '—',
                                      subtitle: _monthlyPackage != null
                                          ? 'Billed monthly'
                                          : '',
                                      selected:
                                          _selected == _PlanOption.monthly,
                                      onTap: () => setState(
                                        () => _selected = _PlanOption.monthly,
                                      ),
                                    ),
                                  ),
                                ],
                              )
                              .animate()
                              .fadeIn(delay: 550.ms, duration: 400.ms)
                              .scale(
                                begin: const Offset(0.95, 0.95),
                                end: const Offset(1, 1),
                                delay: 550.ms,
                                duration: 500.ms,
                                curve: Curves.easeOutBack,
                              ),
                          const Gap(16),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (_loaded)
            Padding(
              padding: Theming.padding.withTop(8),
              child: SafeArea(
                top: false,
                child: Column(
                  children: [
                    SizedBox(
                          width: double.infinity,
                          child: FilledButton(
                            onPressed: _loading ? null : _onContinue,
                            child: _loading
                                ? const SizedBox(
                                    height: 20,
                                    width: 20,
                                    child: CircularProgressIndicator(
                                      strokeWidth: 2,
                                    ),
                                  )
                                : const Text('Continue'),
                          ),
                        )
                        .animate()
                        .fadeIn(delay: 700.ms, duration: 400.ms)
                        .slideY(
                          begin: 0.3,
                          end: 0,
                          duration: 500.ms,
                          curve: Curves.easeOutCubic,
                        ),
                    const Gap(8),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        _FooterLink(
                          label: 'Restore purchases',
                          onTap: () => restorePurchases(),
                        ),
                        _FooterLink(
                          label: 'Terms',
                          onTap: () =>
                              launchUrl(Uri.parse(Flavor.current.termsUrl)),
                        ),
                        _FooterLink(
                          label: 'Privacy',
                          onTap: () =>
                              launchUrl(Uri.parse(Flavor.current.privacyUrl)),
                        ),
                      ],
                    ).animate().fadeIn(delay: 850.ms, duration: 500.ms),
                  ],
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _FooterLink extends StatelessWidget {
  final String label;
  final VoidCallback onTap;

  const _FooterLink({required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;

    return TextButton(
      onPressed: onTap,
      style: TextButton.styleFrom(
        minimumSize: Size.zero,
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      ),
      child: Text(
        label,
        style: theme.textTheme.bodySmall?.copyWith(
          color: colors.onLevel0.secondary(),
        ),
      ),
    );
  }
}

class _FeatureItem extends StatelessWidget {
  final String label;

  const _FeatureItem({required this.label});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Icon(Icons.check_circle, color: colors.blue, size: 22),
          const Gap(12),
          Expanded(child: Text(label, style: theme.textTheme.bodyMedium)),
        ],
      ),
    );
  }
}
