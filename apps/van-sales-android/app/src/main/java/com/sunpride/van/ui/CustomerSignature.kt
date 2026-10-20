package com.sunpride.van.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import org.json.JSONArray
import org.json.JSONObject

/** F-113 normalized strokes retain pen lifts; this is a customer acknowledgement, not an identity signature. */
@Composable fun CustomerSignature(name: String,onName:(String)->Unit,onSignature:(String?)->Unit) {
    val strokes=remember {mutableStateListOf<List<Pair<Int,Int>>>()}
    fun publish() {onSignature(if(name.isBlank() || strokes.none {it.size>=2}) null else JSONObject().put("name",name.trim()).put("accepted",true)
        .put("strokes",JSONArray(strokes.filter {it.size>=2}.map {stroke->JSONArray(stroke.map {JSONArray(listOf(it.first,it.second))})})).toString())}
    LaunchedEffect(name) {publish()}
    LabeledField("Customer acknowledgement name",name,onName,"return-customer-name",maxLength=100)
    Text("Customer: check the returned goods, then sign in the box.",style=MaterialTheme.typography.bodyMedium)
    Canvas(Modifier.fillMaxWidth().height(180.dp).background(Color.White).border(1.dp,MaterialTheme.colorScheme.outline).testTag("return-signature")
        .pointerInput(name) {
            fun normalized(p: Offset)=((p.x/size.width*10000).toInt().coerceIn(0,10000) to (p.y/size.height*10000).toInt().coerceIn(0,10000))
            detectDragGestures(onDragStart={if(strokes.size<30) strokes+=listOf(normalized(it))},onDragEnd={publish()},onDragCancel={publish()}) {change,_->
                change.consume()
                if(strokes.isNotEmpty() && strokes.sumOf {it.size}<2000 && strokes.last().size<1000) strokes[strokes.lastIndex]=strokes.last()+normalized(change.position)
            }
        }) {
        strokes.forEach {stroke->stroke.zipWithNext().forEach {(a,b)->drawLine(Color.Black,Offset(a.first/10000f*size.width,a.second/10000f*size.height),Offset(b.first/10000f*size.width,b.second/10000f*size.height),strokeWidth=3.dp.toPx())}}
    }
    SecondaryButton("Clear signature",{strokes.clear();onSignature(null)})
}
