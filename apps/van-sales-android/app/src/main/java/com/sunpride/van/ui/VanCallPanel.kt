package com.sunpride.van.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.sunpride.callflow.CallFlowEngine
import org.json.JSONObject

/** F-107: retains the POS screens, adding the same configured call lifecycle as field selling. */
@Composable fun VanCallPanel(c: VanController) {
    val customer = c.selectedCustomer ?: return
    val flow = c.callFlow ?: return
    val context = LocalContext.current
    var sequenceReason by remember(customer.outletId) { mutableStateOf("") }
    var unplannedReason by remember(customer.outletId) { mutableStateOf("") }
    val delivery=flow.getJSONObject("definition").optString("channelProfile")=="driver_delivery"
    var zeroSale by remember(customer.outletId) { mutableStateOf(if(delivery) "delivery_only" else "") }
    var shortReason by remember(customer.outletId) { mutableStateOf("") }
    var observation by remember(customer.outletId) { mutableStateOf("") }
    var geofenceReason by remember(customer.outletId) { mutableStateOf("") }
    var pendingKind by remember { mutableStateOf("call.start") }
    val current = c.currentCall
    val openHere = current?.optString("outletId") == customer.outletId
    fun options() = JSONObject().put("sequenceReason",sequenceReason).put("unplannedReason",unplannedReason)
        .put("zeroSaleReason",zeroSale).put("shortCallReason",shortReason)
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        c.recordCallFlow(pendingKind,context,options())
    }
    fun record(kind: String) {
        pendingKind = kind
        if (c.callLocationSource == null && ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
            permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION))
        else c.recordCallFlow(kind,context,options())
    }
    SectionCard(flow.getJSONObject("definition").getString("label")) {
        Text(if (openHere) "Call in progress" else if (current != null) "Finish the open store call first" else "Check in before selling",Modifier.testTag("callflow-state"))
        CallFlowEngine.objects(flow.getJSONObject("definition").getJSONArray("steps")).forEach { step ->
            Text(step.getString("label") + if (step.getBoolean("required")) " · Required" else " · Optional",style = MaterialTheme.typography.bodySmall)
        }
        LabeledField("Outside-radius exception reason",geofenceReason,{geofenceReason=it},"callflow-geofence-reason")
        SecondaryButton("Request supervisor approval",{c.requestCallGeofence(geofenceReason,openHere)},Modifier.testTag("callflow-geofence-request"),!c.busy && geofenceReason.isNotBlank())
        if (!openHere && current == null) {
            if (customer.source != "route") LabeledField("Reason for this unplanned store",unplannedReason,{unplannedReason=it},"callflow-unplanned")
            LabeledField("Reason if visiting out of sequence",sequenceReason,{sequenceReason=it},"callflow-sequence")
            SecondaryButton("Check in",{record("call.start")},Modifier.testTag("callflow-start"),!c.busy)
        }
        if (openHere) {
            if(delivery) DriverDeliveryPanel(c)
            if(CallFlowEngine.keyFor(flow,"stock_check") != null) {
                LabeledField("Stock observation",observation,{observation=it},"callflow-stock-observation")
                SecondaryButton("Save stock check",{c.recordCallFlowStep(JSONObject().put("adapter","stock_check").put("observation",observation))},Modifier.testTag("callflow-stock"),!c.busy && observation.isNotBlank())
            }
            if (CallFlowEngine.keyFor(flow,"evidence") != null) VanCallEvidenceButton(c)
            Text("No order this call",style = MaterialTheme.typography.titleSmall)
            CallFlowEngine.objects(flow.getJSONArray("reasons")).forEach { reason ->
                Row { RadioButton(zeroSale == reason.getString("code"),{zeroSale=reason.getString("code")},Modifier.testTag("callflow-zero-${reason.getString("code")}")); Text(reason.getString("label"),Modifier.padding(top=12.dp)) }
            }
            LabeledField("Reason if shorter than ${flow.getJSONObject("policy").getLong("minDwellMs")/60000} min",shortReason,{shortReason=it},"callflow-short")
            SecondaryButton("Check out",{record("call.close")},Modifier.testTag("callflow-close"),!c.busy)
        }
    }
}
