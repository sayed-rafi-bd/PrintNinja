package com.printninja.android_print

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.net.toUri

/**
 * Battery-optimization exemption. Doze and app standby defer the
 * queue worker and the local API server; the exemption keeps them on
 * schedule. This is strictly opt-in: nothing calls request() except the
 * user's own toggle in Settings → Background, and the current state is
 * readable without prompting.
 */
object BatteryExemption {

    fun isGranted(context: Context): Boolean {
        val power = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        return power.isIgnoringBatteryOptimizations(context.packageName)
    }

    /**
     * Opens the system exemption screen for this app. Returns false when
     * already exempt (nothing to show) or when the OS build cannot show
     * the request (below M); true when the screen was opened.
     */
    fun request(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || isGranted(context)) {
            return false
        }
        val intent = Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            "package:${context.packageName}".toUri(),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        return true
    }
}
