package com.sunpride.field.sell.security

/** A supervisor whose PIN approves a step (shared refund sheet; the van refund itself uses an office code). */
data class Supervisor(val profileId: String, val name: String, val pinId: String, val salt: String, val hash: String)
