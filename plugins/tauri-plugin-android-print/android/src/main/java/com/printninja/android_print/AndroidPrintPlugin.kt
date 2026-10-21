package com.printninja.android_print

import android.app.Activity
import android.graphics.pdf.PdfDocument
import android.hardware.usb.UsbManager
import android.util.Log
import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.ceil
import kotlin.math.roundToInt

@InvokeArg
class HtmlToPdfArgs {
    var html: String? = null
    var pageWidthMm: Double? = null
    var pageHeightMm: Double? = null
    var orientation: String? = null
    var documentName: String? = null
}

@InvokeArg
class TestPrinterArgs {
    var printerId: String? = null
}

@TauriPlugin
class AndroidPrintPlugin(private val activity: Activity) : Plugin(activity) {
    private val tag = "AndroidPrintPlugin"

    /**
     * Renders HTML to a PDF file and resolves with its absolute path. The
     * caller deletes the file when done. Runs the WebView on the UI thread
     * and blocks the invoke thread (bounded, 60s) — never the main thread.
     */
    @Command
    fun htmlToPdf(invoke: Invoke) {
        val args = invoke.parseArgs(HtmlToPdfArgs::class.java)
        val html = args.html ?: return invoke.reject("html is required")
        var widthMm = args.pageWidthMm ?: 210.0
        var heightMm = args.pageHeightMm ?: 297.0
        if (args.orientation == "landscape") {
            val swap = widthMm
            widthMm = heightMm
            heightMm = swap
        }

        val tmp: File
        try {
            tmp = File.createTempFile("pn_render_", ".pdf", activity.cacheDir)
        } catch (e: Exception) {
            return invoke.reject("cannot create render file: ${e.message}")
        }

        var failure: String? = null
        val done = CountDownLatch(1)
        activity.runOnUiThread {
            try {
                val view = WebView(activity)
                view.settings.javaScriptEnabled = false
                view.webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView?, url: String?) {
                        super.onPageFinished(view, url)
                        if (view == null) {
                            failure = "web view gone"
                            done.countDown()
                            return
                        }
                        printToPdf(view, tmp, widthMm, heightMm, done) {
                            failure = it
                        }
                    }
                }
                view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
            } catch (e: Exception) {
                failure = e.message
                done.countDown()
            }
        }

        if (!done.await(60, TimeUnit.SECONDS)) {
            return invoke.reject("render timed out after 60s")
        }
        failure?.let { return invoke.reject(it) }
        val result = JSObject()
        result.put("path", tmp.absolutePath)
        invoke.resolve(result)
    }

    /**
     * Headless render without the print framework: the print
     * framework's adapter callbacks have package-private constructors,
     * so apps cannot drive PrintDocumentAdapter directly. Instead the
     * WebView is measured at the exact label size and drawn page by
     * page onto a PdfDocument — all public API, same @page dimensions
     * the desktop renderers honor. Must run on the UI thread.
     */
    private fun printToPdf(
        view: WebView,
        tmp: File,
        widthMm: Double,
        heightMm: Double,
        done: CountDownLatch,
        onError: (String) -> Unit,
    ) {
        try {
            val metrics = view.resources.displayMetrics
            val dotsPerMm = metrics.densityDpi / 25.4
            val widthPx = (widthMm * dotsPerMm).roundToInt().coerceAtLeast(1)
            val heightPx = (heightMm * dotsPerMm).roundToInt().coerceAtLeast(1)

            view.measure(
                View.MeasureSpec.makeMeasureSpec(widthPx, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
            )
            val contentHeightPx = maxOf(view.measuredHeight, 1)
            view.layout(0, 0, widthPx, contentHeightPx)

            // PDF points stay device-independent: px * 72 / dpi.
            val widthPt = (widthPx * 72.0 / metrics.densityDpi).roundToInt()
            val heightPt = (heightPx * 72.0 / metrics.densityDpi).roundToInt()
            val contentHeightPt = (contentHeightPx * 72.0 / metrics.densityDpi).roundToInt()

            val pdf = PdfDocument()
            val pageCount = maxOf(1, ceil(contentHeightPt.toDouble() / heightPt).toInt())
            for (pageNo in 1..pageCount) {
                val info = PdfDocument.PageInfo.Builder(widthPt, heightPt, pageNo).create()
                val page = pdf.startPage(info)
                // Shift the canvas so each page shows its own slice.
                page.canvas.translate(0f, (-(pageNo - 1) * heightPx).toFloat())
                page.canvas.scale(
                    72f / metrics.densityDpi,
                    72f / metrics.densityDpi,
                )
                view.draw(page.canvas)
                pdf.finishPage(page)
            }
            FileOutputStream(tmp).use { pdf.writeTo(it) }
            pdf.close()
            view.destroy()
            done.countDown()
        } catch (e: Exception) {
            Log.e(tag, "print render failed", e)
            onError("print render failed: ${e.message}")
            done.countDown()
        }
    }

    @Command
    fun enumerateUsbPrinters(invoke: Invoke) {
        val usbManager = activity.getSystemService(Activity.USB_SERVICE) as UsbManager
        val result = org.json.JSONArray()
        for ((name, device) in usbManager.deviceList) {
            val obj = org.json.JSONObject()
            obj.put("id", device.deviceName)
            obj.put("name", name)
            obj.put("vendorId", device.vendorId)
            obj.put("productId", device.productId)
            result.put(obj)
        }
        invoke.resolve(JSObject().put("printers", result))
    }

    @Command
    fun testPrinter(invoke: Invoke) {
        invoke.parseArgs(TestPrinterArgs::class.java)
        // Reachability is probed by the transport before a job is sent;
        // the command only confirms the plugin round-trip works.
        invoke.resolve(JSObject().put("success", true))
    }

    // ── Background service ─────────────────────────────────────────

    @Command
    fun startBackgroundService(invoke: Invoke) {
        PrintNinjaService.start(activity)
        invoke.resolve(JSObject().put("running", true))
    }

    @Command
    fun stopBackgroundService(invoke: Invoke) {
        PrintNinjaService.stop(activity)
        invoke.resolve()
    }

    @Command
    fun isBackgroundServiceRunning(invoke: Invoke) {
        invoke.resolve(JSObject().put("running", PrintNinjaService.isRunning))
    }

    @Command
    fun requestBatteryExemption(invoke: Invoke) {
        val granted = BatteryExemption.request(activity)
        invoke.resolve(JSObject().put("granted", granted))
    }

    @Command
    fun isBatteryExemptionGranted(invoke: Invoke) {
        invoke.resolve(JSObject().put("granted", BatteryExemption.isGranted(activity)))
    }

    /**
     * Starts the foreground print service when the plugin loads at app
     * startup, so the queue survives before any command runs. The app
     * also starts it from the webview on launch; starting twice is a
     * no-op by Android contract.
     */
    override fun load(webView: WebView) {
        super.load(webView)
        try {
            PrintNinjaService.start(activity)
        } catch (e: Exception) {
            Log.w(tag, "could not start background service: ${e.message}")
        }
    }
}
