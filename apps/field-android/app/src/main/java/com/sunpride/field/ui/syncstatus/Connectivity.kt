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

/** Observe connectivity only, never toggle it or infer server acceptance from it. */
@Composable
fun rememberOffline(): Boolean {
    val context = androidx.compose.ui.platform.LocalContext.current
    val manager = remember(context) { context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager }
    var offline by remember(manager) { mutableStateOf(
        manager.getNetworkCapabilities(manager.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) != true
    ) }
    DisposableEffect(manager) {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                offline = manager.getNetworkCapabilities(manager.activeNetwork)
                    ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) != true
            }
            override fun onLost(network: Network) {
                offline = manager.getNetworkCapabilities(manager.activeNetwork)
                    ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) != true
            }
            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                offline = !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            }
        }
        manager.registerNetworkCallback(NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), callback,
            android.os.Handler(android.os.Looper.getMainLooper()))
        onDispose { manager.unregisterNetworkCallback(callback) }
    }
    return offline
}
