import 'package:app/theme/app_colors.dart';
import 'package:flutter/material.dart';

/// A theme carrying the app's colour extension, without the app's Google
/// Fonts (which would try to download fonts in tests).
ThemeData testTheme() => ThemeData(
  extensions: const [
    AppColors(
      primary: Colors.black,
      onPrimary: Colors.white,
      error: Colors.red,
      onError: Colors.white,
      success: Colors.green,
      onSuccess: Colors.white,
      blue: Colors.blue,
      onBlue: Colors.white,
      level0: Colors.white,
      onLevel0: Colors.black,
      level1: Color(0xFFEEEEEE),
      onLevel1: Colors.black,
      level2: Color(0xFFE0E0E0),
      onLevel2: Colors.black,
    ),
  ],
);
