package com.printninja.android_print

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log

class MdnsDiscovery(private val context: Context) {
    private val TAG = "MdnsDiscovery"
    private val nsdManager = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val listeners = mutableMapOf<String, NsdManager.DiscoveryListener>()

    fun startDiscovery(serviceType: String = "_ipp._tcp.", onFound: (String, String, Int) -> Unit) {
        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                Log.d(TAG, "Discovery started: $serviceType")
            }

            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                Log.d(TAG, "Service found: ${serviceInfo.serviceName}")
                resolveService(serviceInfo, onFound)
            }

            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                Log.d(TAG, "Service lost: ${serviceInfo.serviceName}")
            }

            override fun onDiscoveryStopped(serviceType: String) {
                Log.d(TAG, "Discovery stopped: $serviceType")
            }

            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.e(TAG, "Start discovery failed: $errorCode")
            }

            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.e(TAG, "Stop discovery failed: $errorCode")
            }
        }

        listeners[serviceType] = listener
        nsdManager.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
    }

    fun stopDiscovery(serviceType: String = "_ipp._tcp.") {
        listeners[serviceType]?.let { nsdManager.stopServiceDiscovery(it) }
        listeners.remove(serviceType)
    }

    private fun resolveService(serviceInfo: NsdServiceInfo, onFound: (String, String, Int) -> Unit) {
        nsdManager.resolveService(serviceInfo, object : NsdManager.ResolveListener {
            override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                Log.e(TAG, "Resolve failed: $errorCode")
            }

            override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                val host = serviceInfo.host?.hostAddress ?: return
                val port = serviceInfo.port
                val name = serviceInfo.serviceName
                onFound(name, host, port)
            }
        })
    }
}
