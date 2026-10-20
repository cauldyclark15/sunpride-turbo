package com.sunpride.van.storage

/** Legacy fixtures retain their contract; production v2 partitions require a complete current grant. */
fun SyncMetaRow.authorizes(now: Long): Boolean = !held && (!fullAuthSubject.startsWith("v2|") ||
    cursor != null && scopeFingerprint != null && authorizationEpoch != null &&
    leaseExpiresAt != null && leaseExpiresAt > now && cacheExpiresAt != null && cacheExpiresAt > now)
