package com.silentsilo.mobile

import android.app.UiModeManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatDelegate

// The theme chosen in the app, kept here as well, so the system bars, the
// window behind the page and the splash screen follow it rather than the
// phone's own setting.
object Appearance {
  private const val PREFS = "appearance"
  private const val KEY = "theme"

  // What enableEdgeToEdge uses by default behind three-button navigation.
  private val LIGHT_SCRIM = Color.argb(0xe6, 0xff, 0xff, 0xff)
  private val DARK_SCRIM = Color.argb(0x80, 0x1b, 0x1b, 0x1b)

  private fun saved(context: Context): String =
    context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, "system") ?: "system"

  // Before the activity attaches, so its first frame is already in the right theme.
  fun applySaved(context: Context) {
    AppCompatDelegate.setDefaultNightMode(appCompatMode(saved(context)))
  }

  // From the page: the user picked a theme, or the page started and says
  // which one it shows.
  fun choose(activity: ComponentActivity, choice: String) {
    if (choice != saved(activity)) {
      activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, choice).apply()
      // The splash screen at the next cold start, which no app code reaches.
      activity.getSystemService(UiModeManager::class.java)?.setApplicationNightMode(
        when (choice) {
          "dark" -> UiModeManager.MODE_NIGHT_YES
          "light" -> UiModeManager.MODE_NIGHT_NO
          else -> UiModeManager.MODE_NIGHT_AUTO
        }
      )
    }
    AppCompatDelegate.setDefaultNightMode(appCompatMode(choice))
    systemBars(activity)
  }

  // Light icons on a dark page and dark icons on a light one.
  fun systemBars(activity: ComponentActivity) {
    val night = activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK
    val dark = night == Configuration.UI_MODE_NIGHT_YES
    activity.enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT) { dark },
      navigationBarStyle = SystemBarStyle.auto(LIGHT_SCRIM, DARK_SCRIM) { dark },
    )
  }

  private fun appCompatMode(choice: String) = when (choice) {
    "dark" -> AppCompatDelegate.MODE_NIGHT_YES
    "light" -> AppCompatDelegate.MODE_NIGHT_NO
    else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
  }
}
