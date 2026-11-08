package com.sunpride.field.census

import androidx.activity.enableEdgeToEdge
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.SunprideTokens
import com.sunpride.field.ui.customers.CustomerRecord
import com.sunpride.field.ui.diagnosticvisit.AndroidVisitLocation
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** SP-0163 DEBUG-ONLY proof harness: the real Add a store screen and the phone's real location provider, with a fake
 * API (no network, no Google key). `--ez old true` simulates a server that does not know the new endpoints. */
class AddStorePreviewActivity : ComponentActivity() {
    @OptIn(ExperimentalComposeUiApi::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val old = intent.getBooleanExtra("old", false)
        val offline = intent.getBooleanExtra("offline", false)
        val batch = UUID.randomUUID().toString(); val channel = UUID.randomUUID().toString()
        val config = JSONObject().put("addressSearch", !old)
            .put("batches", JSONArray().put(JSONObject().put("id", batch).put("name", "Ongoing store gathering")))
            .put("channels", JSONArray().put(JSONObject().put("id", channel).put("label", "General trade")))
            .put("subchannels", JSONArray().put(JSONObject().put("id", UUID.randomUUID().toString()).put("label", "Sari-sari").put("data", JSONObject().put("channelId", channel))))
        if (!old) config.put("defaultBatch", JSONObject().put("id", batch).put("name", "Ongoing store gathering"))
        val places = CensusPlaces({ path ->
            Thread.sleep(250)
            when {
                offline -> throw AuthFailure(AuthFailure.Kind.OFFLINE)
                old -> throw com.sunpride.field.auth.ServerError(null)
                path.startsWith("/api/v1/places/reverse") -> JSONObject("""{"formattedAddress":"12 Colon St, Kalubihan, Cebu City","components":{"barangay":"Kalubihan","city":"Cebu City"}}""")
                path.startsWith("/api/v1/places/autocomplete") -> JSONObject("""{"predictions":[{"placeId":"P-sm","primary":"SM Seaside City Cebu","secondary":"Cebu South Coastal Road, Cebu City","description":"SM Seaside City Cebu"},{"placeId":"P-sm2","primary":"SM City Cebu","secondary":"North Reclamation Area, Cebu City","description":"SM City Cebu"}]}""")
                path.startsWith("/api/v1/places/details") -> JSONObject("""{"placeId":"P-sm","formattedAddress":"Cebu South Coastal Rd, Mambaling, Cebu City","latitude":10.2817,"longitude":123.8805,"components":{"barangay":"Mambaling","city":"Cebu City"}}""")
                else -> throw AuthFailure(AuthFailure.Kind.SERVER)
            }
        }, { _, _ -> if (old) throw com.sunpride.field.auth.ServerError(null) else JSONObject("""{"candidates":[{"kind":"capture","id":"c-1","code":null,"name":"Nena Store (waiting for review)","address":"Colon St","latitude":null,"longitude":null,"distanceMeters":null,"reasons":["phone"],"score":90}],"truncated":false}""") })
        val saved = mutableListOf<Pair<String, String>>()
        val backend = object : FieldBackend {
            override val isSignedIn = true
            override fun loadSigner(): DeviceSigner = error("preview")
            override fun signIn(email: String, password: String) = Unit
            override fun signOut() = Unit
            override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.SignedOut
            override fun censusConfig() = config
            override fun censusPlaces() = places
            override fun censusHistory() = saved.toList()
            override fun queueCensus(payload: JSONObject) {
                CensusRules.validate(payload)
                android.util.Log.i("AddStorePreview", "queued source=${payload.optString("locationSource")} batch=${payload.has("batchId")} " +
                    "landmark=${payload.has("landmark")} acknowledged=${payload.optJSONArray("acknowledgedDuplicateIds")?.length() ?: 0}")
                saved += payload.getString("name") to "pending"
            }
        }
        val stores = listOf(CustomerRecord("o1", "ALING NENA STORE", address = "Colon St, Cebu City", latitude = 10.31585, longitude = 123.88545))
        setContent {
            MaterialTheme(colorScheme = SunprideTokens.lightColors) {
                Surface(Modifier.fillMaxSize().statusBarsPadding().semantics { testTagsAsResourceId = true }) {
                    CensusScreen(backend, AndroidVisitLocation(this), { finish() }, stores = stores)
                }
            }
        }
    }
}
