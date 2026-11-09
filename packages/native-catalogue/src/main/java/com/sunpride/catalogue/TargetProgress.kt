package com.sunpride.catalogue

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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
    private fun pesos(v:BigDecimal):String{val p=v.movePointLeft(2);val whole=p.stripTrailingZeros().scale()<=0
        return "₱"+NumberFormat.getNumberInstance(Locale.ENGLISH).apply{minimumFractionDigits=if(whole)0 else 2;maximumFractionDigits=2}.format(p)}
    private fun count(v:BigDecimal)=NumberFormat.getNumberInstance(Locale.ENGLISH).apply{maximumFractionDigits=2}.format(v)
    /** Plain unit words for reps. */
    fun unitWord(unit:String)=when(unit){"store-SKU points"->"products in stores";"EA"->"pcs";else->unit}
    fun value(v:BigDecimal?,unit:String):String {
        if(v==null)return "Not recorded"
        return when(unit){"centavos"->pesos(v);"basis points"->v.movePointLeft(2).stripTrailingZeros().toPlainString()+"%";else->count(v)+" "+unitWord(unit)}
    }
    /** Big number on the right: money and % as-is, counts without the unit (the label names it). */
    fun big(v:BigDecimal?,unit:String)=when{v==null->"—";unit=="centavos"||unit=="basis points"->value(v,unit);else->count(v)}
    fun target(row:TargetMeasure)=row.target?.let{"of "+value(it,row.unit)}
    fun lastMonth(row:TargetMeasure)=row.prior?.let{"Last month "+value(if(row.unit=="centavos")it.movePointLeft(2).setScale(0,java.math.RoundingMode.HALF_UP).movePointRight(2) else it,row.unit)}
    fun status(row:TargetMeasure)=if(row.target==null)null else when(row.status){"on_target","on_pace"->"On track";"behind"->"Behind";else->null}
    fun fraction(row:TargetMeasure):Float?{val t=row.target?:return null;if(t.signum()==0)return 1f
        return ((row.actual?:BigDecimal.ZERO).toDouble()/t.toDouble()).toFloat().coerceIn(0f,1f)}
    fun updated(date:String)=runCatching{"Updated "+java.time.LocalDate.parse(date).format(java.time.format.DateTimeFormatter.ofPattern("MMM d",Locale.ENGLISH))}.getOrDefault("Updated $date")
    const val MISSING_NOTE="Targets not set yet — ask your supervisor"
    const val SHOWN=4
}
@Composable private fun TargetRow(row:TargetMeasure){
    Column(Modifier.fillMaxWidth().testTag("target-row-${row.metric}${row.label.hashCode()}"),verticalArrangement=Arrangement.spacedBy(4.dp)){
        Row(verticalAlignment=Alignment.CenterVertically){
            Text(row.label,Modifier.weight(1f).padding(end=8.dp),style=MaterialTheme.typography.bodyLarge,maxLines=2,overflow=TextOverflow.Ellipsis)
            Text(TargetProgressText.big(row.actual,row.unit),style=MaterialTheme.typography.titleLarge,fontWeight=FontWeight.SemiBold,maxLines=1)
        }
        val muted=MaterialTheme.colorScheme.onSurfaceVariant
        val f=TargetProgressText.fraction(row)
        if(f!=null){
            LinearProgressIndicator(progress={f},modifier=Modifier.fillMaxWidth().height(6.dp),drawStopIndicator={})
            Row(verticalAlignment=Alignment.CenterVertically){
                Text(TargetProgressText.target(row)!!,Modifier.weight(1f),style=MaterialTheme.typography.bodyMedium,color=muted)
                TargetProgressText.status(row)?.let{s->
                    val behind=s=="Behind"
                    Surface(shape=MaterialTheme.shapes.small,color=if(behind)MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer,
                        contentColor=if(behind)MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSecondaryContainer){
                        Text(s,Modifier.padding(horizontal=8.dp,vertical=2.dp),style=MaterialTheme.typography.labelMedium)}
                }
            }
        }else Text("No target yet",style=MaterialTheme.typography.bodyMedium,color=muted)
        TargetProgressText.lastMonth(row)?.let{Text(it,style=MaterialTheme.typography.bodySmall,color=muted)}
    }
}
@Composable fun TargetProgressCard(view:TargetProgressView,modifier:Modifier=Modifier){
    var expired by remember(view.data?.expiresAt){mutableStateOf(false)}
    var all by remember(view.data?.profileId,view.data?.month){mutableStateOf(false)}
    var details by remember{mutableStateOf(false)}
    LaunchedEffect(view.data?.expiresAt){view.data?.let{kotlinx.coroutines.delay((it.expiresAt-System.currentTimeMillis()).coerceAtLeast(0)+1);expired=true}}
    val data=view.data?.takeIf{!expired&&it.expiresAt>System.currentTimeMillis()&&view.current()}
    val muted=MaterialTheme.colorScheme.onSurfaceVariant
    Surface(modifier.fillMaxWidth().testTag("month-targets"),shape=MaterialTheme.shapes.medium){Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)){
        Row(verticalAlignment=Alignment.Bottom){
            Text("This month",Modifier.weight(1f),style=MaterialTheme.typography.titleMedium)
            data?.let{Text(TargetProgressText.updated(it.date),style=MaterialTheme.typography.bodySmall,color=muted)}
        }
        if(data==null){Text(view.message?:"Sync to see current targets",color=muted);return@Column}
        view.message?.let{Text(it,style=MaterialTheme.typography.bodySmall,color=muted)}
        val rows=if(all)data.rows else data.rows.take(TargetProgressText.SHOWN)
        rows.forEachIndexed{i,row->if(i>0)HorizontalDivider();TargetRow(row)}
        if(data.rows.size>TargetProgressText.SHOWN)TextButton({all=!all},Modifier.testTag("targets-show-all"),contentPadding=PaddingValues(0.dp)){Text(if(all)"Show less" else "Show all (${data.rows.size})")}
        if(data.rows.any{it.target==null})Text(TargetProgressText.MISSING_NOTE,style=MaterialTheme.typography.bodyMedium,color=muted)
        TextButton({details=!details},Modifier.testTag("targets-details"),contentPadding=PaddingValues(0.dp)){Text(if(details)"Hide details" else "Details")}
        if(details)Column(verticalArrangement=Arrangement.spacedBy(6.dp)){
            if(view.savedAt!=null)Text("Saved copy — work still on this phone is not counted yet.",style=MaterialTheme.typography.bodySmall,color=muted)
            data.rows.mapNotNull{it.sourceRef}.distinct().forEach{Text("Target source: $it",style=MaterialTheme.typography.bodySmall,color=muted)}
            Text(data.definition,style=MaterialTheme.typography.bodySmall,color=muted)
        }
    }}
}
