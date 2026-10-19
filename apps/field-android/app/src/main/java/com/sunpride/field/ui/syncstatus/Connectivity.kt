package com.sunpride.field.ui.syncstatus

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue

/**
 * Which networks with internet are up, from the callbacks themselves. Re-reading the "active" network inside
 * onLost races: Android can still report the network being lost, so the phone kept saying "All synced"
 * after Wi-Fi and data were turned off. Pure so it is unit-tested.
 */
class InternetNetworks(initiallyOnline: Boolean) {
    private val up = mutableSetOf<String>()
    private var assumeOnline = initiallyOnline
    val offline: Boolean get() = up.isEmpty() && !assumeOnline
    fun available(id: String) { up += id; assumeOnline = false }
    fun lost(id: String) { up -= id; assumeOnline = false }
    fun capabilities(id: String, internet: Boolean) { if (internet) up += id else up -= id; assumeOnline = false }
}

/** Observe connectivity only, never toggle it or infer server acceptance from it. */
@Composable
fun rememberOffline(): Boolean {
    val context = androidx.compose.ui.platform.LocalContext.current
    val manager = remember(context) { context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager }
    val networks = remember(manager) { InternetNetworks(
        manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true) }
    var offline by remember(manager) { mutableStateOf(networks.offline) }
    DisposableEffect(manager) {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { networks.available(network.toString()); offline = networks.offline }
            override fun onLost(network: Network) { networks.lost(network.toString()); offline = networks.offline }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                networks.capabilities(network.toString(), caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
                offline = networks.offline
            }
        }
        manager.registerNetworkCallback(NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), callback,
            android.os.Handler(android.os.Looper.getMainLooper()))
        onDispose { manager.unregisterNetworkCallback(callback) }
    }
    return offline
}
