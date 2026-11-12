package com.sunpride.van.data

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flowOn

/**
 * NF-R5V-6: the repository's screen flows decode Room rows (policy JSON, products, stock projection, sync status) in
 * their map/combine operators. Without a dispatcher those operators run in the collector's context, which is the
 * controller's Main scope, so a sync that rewrites the outbox and sync_meta many times re-parsed everything on the
 * UI thread and froze the app ("isn't responding"). Every screen flow does that work on [dispatcher] and only hands
 * Main a value that actually changed.
 */
fun <T> Flow<T>.offMain(dispatcher: CoroutineDispatcher = Dispatchers.Default): Flow<T> = distinctUntilChanged().flowOn(dispatcher)
