package com.sunpride.catalogue

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.math.BigDecimal
import java.text.NumberFormat
import java.util.Locale

/** F-615 one strict read model and presentation in both existing Android products. */
data class TargetMeasure(val metric:String,val label:String,val unit:String,val target:BigDecimal?,val actual:BigDecimal?,val prior:BigDecimal?,val pace:BigDecimal?,val status:String,val nextAction:String,val sourceRef:String?)
data class TargetProgress(val profileId:String,val month:String,val date:String,val expiresAt:Long,val definition:String,val rows:List<TargetMeasure>)
data class TargetProgressView(val data:TargetProgress?=null,val savedAt:Long?=null,val message:String?=null,val current:()->Boolean={true})
interface TargetProgressCache {
    fun current():Boolean
    fun revoke()
    fun read(day:String):Pair<String,Long>?
    fun write(day:String,text:String,at:Long)
}
object TargetProgressCodec {
    const val PATH="coverage/targets:mine"
    const val PROJECTION="targets.progress"
    val METRICS=setOf("sales_value","volume","coverage_stores","distribution_points","calls","msl_compliance")
    fun decode(text:String,day:String):TargetProgress{
        val o=JSONObject(text);require(o.getInt("version")==1&&o.getString("asOfDate")==day&&o.getString("month")==day.take(7))
        val rows=o.getJSONArray("rows");require(rows.length() in 6..105)
        val identities=mutableSetOf<String>()
        val values=(0 until rows.length()).map{i->val r=rows.getJSONObject(i)
            fun amount(k:String):BigDecimal?{if(r.isNull(k))return null;val raw=r.get(k);require(raw is Number);return BigDecimal(raw.toString()).also{require(it.abs()<=BigDecimal("9007199254740991"))}}
            val metric=r.getString("metric");require(metric in METRICS)
            require(identities.add("$metric:${r.optString("productCode")}"))
            val status=r.getString("status");require(status in setOf("not_set","unknown","on_target","on_pace","behind"))
            TargetMeasure(metric,r.getString("label").also{require(it.length in 1..300)},r.getString("unit"),amount("target")?.also{require(it.signum()>=0)},amount("actual"),amount("prior"),amount("paceTarget"),status,r.getString("nextAction"),r.optString("sourceRef").takeIf{it.isNotBlank()&&it!="null"})
        }
        require(values.map{it.metric}.toSet()==METRICS)
        require(values.filter{it.metric!="volume"}.groupBy{it.metric}.values.all{it.size==1})
        return TargetProgress(o.getString("profileId"),o.getString("month"),day,o.getLong("expiresAt"),o.getString("definition"),values)
    }
    fun request(binding:SapMasterMirror.Binding,day:String)=JSONObject().put("version",2).put("app",binding.app).put("deviceId",binding.deviceId).put("since",JSONObject.NULL).put("pageCursor",JSONObject.NULL)
        .put("scopes",org.json.JSONArray().put(JSONObject().put("scopeId",binding.scopeId).put("projection",PROJECTION).put("params",JSONObject().put("serviceDate",day)))).put("limit",128)
    fun response(response:JSONObject,binding:SapMasterMirror.Binding,day:String):String{
        require(response.getInt("version")==2&&!response.getBoolean("hasMore"));val bundles=response.getJSONArray("bundles");require(bundles.length()==1)
        val b=bundles.getJSONObject(0);require(b.getString("scopeId")==binding.scopeId&&b.getString("scopeFingerprint")==binding.fingerprint&&b.getString("projection")==PROJECTION&&b.getString("mode")=="snapshot"&&b.getBoolean("complete")&&b.getJSONArray("changes").length()==0)
        require(b.getJSONObject("params").getString("serviceDate")==day)
        val expiry=minOf(b.getJSONObject("authorization").getLong("expiresAt"),b.getJSONObject("offlineLease").getLong("expiresAt"))
        require(expiry>response.getLong("serverTime"))
        return JSONObject(b.getJSONObject("data").toString()).put("expiresAt",expiry).toString().also{decode(it,day)}
    }
}
object TargetProgressRepository {
    fun load(day:String,cache:TargetProgressCache,now:Long,fetch:(()->String)?,denied:(Exception)->Boolean):TargetProgressView{
        fun saved(message:String?):TargetProgressView{
            if(!cache.current())return TargetProgressView(message="Refresh authorization to see targets")
            val hit=runCatching{cache.read(day)}.getOrNull()
            val data=hit?.let{runCatching{TargetProgressCodec.decode(it.first,day)}.getOrNull()}?.takeIf{it.expiresAt>now}
            return TargetProgressView(data,if(data==null)null else hit?.second,message?:if(data==null)"Sync to see published month targets"else null,cache::current)
        }
        if(fetch==null)return saved(null)
        return try{
            val text=fetch();if(!cache.current())return TargetProgressView(message="Authorization changed; refresh targets")
            val data=TargetProgressCodec.decode(text,day);require(data.expiresAt>now)
            cache.write(day,text,now)
            if(!cache.current())TargetProgressView(message="Targets are unavailable for the current account")else TargetProgressView(data,current=cache::current)
        }catch(e:Exception){
            if(e is kotlinx.coroutines.CancellationException)throw e
            if(denied(e)){runCatching{cache.revoke()};TargetProgressView(message="Targets are not available for this account")}
            else saved("Offline · saved office actuals")
        }
    }
}
object TargetProgressText {
    fun value(v:BigDecimal?,unit:String):String {
        if(v==null)return "Not recorded"
        return when(unit){"centavos"->"₱"+NumberFormat.getNumberInstance(Locale.ENGLISH).apply{minimumFractionDigits=2;maximumFractionDigits=2}.format(v.movePointLeft(2));"basis points"->v.movePointLeft(2).stripTrailingZeros().toPlainString()+"%";else->v.stripTrailingZeros().toPlainString()+" "+unit}
    }
}
@Composable fun TargetProgressCard(view:TargetProgressView,modifier:Modifier=Modifier){
    var expired by remember(view.data?.expiresAt){mutableStateOf(false)}
    var page by remember(view.data?.profileId,view.data?.month){mutableStateOf(0)}
    LaunchedEffect(view.data?.expiresAt){view.data?.let{kotlinx.coroutines.delay((it.expiresAt-System.currentTimeMillis()).coerceAtLeast(0)+1);expired=true}}
    val data=view.data?.takeIf{!expired&&it.expiresAt>System.currentTimeMillis()&&view.current()}
    Surface(modifier.fillMaxWidth().testTag("month-targets"),shape=MaterialTheme.shapes.medium){Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
        Text("Month targets",style=MaterialTheme.typography.titleMedium)
        if(data==null)Text(view.message?:"Sync to see current targets")else{
            Text("${data.month} · office actuals through ${data.date}")
            view.message?.let{Text(it)}
            view.savedAt?.let{Text("Saved office snapshot · pending phone work is not yet included",style=MaterialTheme.typography.bodySmall)}
            val shownPage=page.coerceIn(0,data.rows.lastIndex/6)
            for(row in data.rows.drop(shownPage*6).take(6)){Column(verticalArrangement=Arrangement.spacedBy(2.dp)){
                Text(row.label,style=MaterialTheme.typography.titleSmall)
                Text("${TargetProgressText.value(row.actual,row.unit)} / ${row.target?.let{TargetProgressText.value(it,row.unit)}?:"Not published"}")
                Text("Pace ${TargetProgressText.value(row.pace,row.unit)} · prior comparable period ${TargetProgressText.value(row.prior,row.unit)}",style=MaterialTheme.typography.bodySmall)
                if(row.status in setOf("behind","unknown","not_set"))Text(row.nextAction,style=MaterialTheme.typography.bodySmall)
                row.sourceRef?.let{Text("Target source: $it",style=MaterialTheme.typography.bodySmall)}
            }}
            if(data.rows.size>6){
                Text("${shownPage*6+1}–${minOf((shownPage+1)*6,data.rows.size)} of ${data.rows.size} targets")
                Row(horizontalArrangement=Arrangement.spacedBy(8.dp)){
                    OutlinedButton({page=shownPage-1},enabled=shownPage>0){Text("Previous")}
                    OutlinedButton({page=shownPage+1},enabled=(shownPage+1)*6<data.rows.size){Text("Next")}
                }
            }
            Text(data.definition,style=MaterialTheme.typography.bodySmall)
        }
    }}
}
