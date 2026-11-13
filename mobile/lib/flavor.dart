import 'dart:io' show Platform;

import 'package:flutter/services.dart';

enum Flavor {
  prod,
  dev,
  emulators;

  static late Flavor current;

  bool get isProd => this == Flavor.prod;
  bool get isDev => this == Flavor.dev;
  bool get isEmulators => this == Flavor.emulators;

  String get title {
    switch (this) {
      case Flavor.prod:
        return 'Voquill';
      case Flavor.dev:
        return 'Voquill Dev';
      case Flavor.emulators:
        return 'Voquill Emulator';
    }
  }

  Color? get color {
    switch (this) {
      case Flavor.dev:
        return const Color.fromARGB(255, 66, 133, 244);
      case Flavor.emulators:
        return const Color.fromARGB(255, 177, 90, 183);
      default:
        return null;
    }
  }

  String get shortName {
    switch (this) {
      case Flavor.prod:
        return 'prod';
      case Flavor.dev:
        return 'dev';
      case Flavor.emulators:
        return 'emu';
    }
  }

  String get emulatorHost => Platform.isAndroid ? '10.0.2.2' : 'localhost';

  /// The Voquill REST server (`core/server`), matching desktop's
  /// `VITE_NEW_SERVER_URL` per environment.
  String get apiBaseUrl {
    switch (this) {
      case Flavor.prod:
        return 'https://api.voquill.com';
      case Flavor.dev:
        return 'https://api-dev.voquill.com';
      case Flavor.emulators:
        return 'http://$emulatorHost:6325';
    }
  }

  String get termsUrl => 'https://voquill.com/terms';
  String get privacyUrl => 'https://voquill.com/privacy';

  static void set(Flavor value) {
    current = value;
  }
}
