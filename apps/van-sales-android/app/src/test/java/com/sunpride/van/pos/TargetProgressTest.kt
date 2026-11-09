package com.sunpride.van.pos

import com.sunpride.catalogue.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.math.BigDecimal
import java.util.UUID

class TargetProgressTest {
    private fun wire()=JSONObject(checkNotNull(javaClass.classLoader!!.getResourceAsStream("target-progress-v1.json")).bufferedReader().use{it.readText()})
    private fun raw():Triple<String,String,Long>{
        val w=wire();val b=w.getJSONArray("bundles").getJSONObject(0);val day=b.getJSONObject("params").getString("serviceDate")
        val binding=SapMasterMirror.Binding("field-android","fixture-device",b.getString("scopeId"),b.getString("scopeFingerprint"))
        return Triple(TargetProgressCodec.response(w,binding,day),day,w.getLong("serverTime"))
    }
    @Test fun F615_exactSignedServerResultKeepsSixMeasuresBaseUnitsRatesAndMoney(){
        val (text,day,_)=raw();val data=TargetProgressCodec.decode(text,day)
        assertEquals(TargetProgressCodec.METRICS,data.rows.map{it.metric}.toSet())
        val volume=data.rows.single{it.metric=="volume"};assertEquals("EA",volume.unit);assertEquals(BigDecimal("24"),volume.actual);assertEquals(BigDecimal("12"),volume.prior)
        val sales=data.rows.single{it.metric=="sales_value"};assertEquals("₱200",TargetProgressText.value(sales.actual,sales.unit))
        val msl=data.rows.single{it.metric=="msl_compliance"};assertEquals("100%",TargetProgressText.value(msl.actual,msl.unit));assertEquals("on_target",msl.status)
        assertEquals("Not recorded",TargetProgressText.value(null,"EA"))
        assertThrows(IllegalArgumentException::class.java){TargetProgressCodec.decode(JSONObject(text).put("asOfDate","2000-01-01").toString(),day)}
    }
    private class Cache(val grant:ProjectionGrant,val values:MutableMap<String,Pair<String,Long>>,val alive:()->Boolean={true}):TargetProgressCache{
        override fun current()=alive()&&grant.current()
        override fun read(day:String)=values[day]?.let{grant.read(it.first)?.let{raw->raw to it.second}}
        override fun write(day:String,text:String,at:Long){values[day]=checkNotNull(grant.wrap(text)) to at}
        override fun revoke(){grant.deny()}
    }
    @Test fun F615_offlineUsesOnlyGrantedSavedFactsAndNeverAnOldSuccessAfterANewerDenial(){
        val (text,day,now)=raw();val prefs=mutableMapOf<String,String>();val account="SAMPLE-"+UUID.randomUUID();val saved=mutableMapOf<String,Pair<String,Long>>()
        fun grant()=ProjectionGrant(account,"targets",{prefs[it]},{k,v->prefs[k]=v;true}).also{it.begin(day)}
        val first=Cache(grant(),saved)
        assertNotNull(TargetProgressRepository.load(day,first,now,{text}){false}.data)
        val offline=Cache(grant(),saved)
        assertNotNull(TargetProgressRepository.load(day,offline,now,null){false}.data)
        assertEquals(now,TargetProgressRepository.load(day,offline,now,null){false}.savedAt)
        val late=Cache(grant(),saved)
        val result=TargetProgressRepository.load(day,late,now,{
            val intermediate=grant();intermediate.begin("another-filter")
            val denial=Cache(grant(),saved)
            assertNull(TargetProgressRepository.load(day,denial,now,{throw SecurityException("SAMPLE refused")}){true}.data)
            text
        }){false}
        assertNull(result.data)
        assertNull(TargetProgressRepository.load(day,Cache(grant(),saved),now,null){false}.data)
    }
    @Test fun F615_aFailedDenialMarkerCannotRepublishTheAlreadyShownView(){
        val (text,day,now)=raw();var commits=true;val prefs=mutableMapOf<String,String>();val saved=mutableMapOf<String,Pair<String,Long>>()
        val grant=ProjectionGrant("SAMPLE-"+UUID.randomUUID(),"targets",{prefs[it]},{k,v->if(commits){prefs[k]=v;true}else false}).also{it.begin(day)}
        val cache=Cache(grant,saved);val shown=TargetProgressRepository.load(day,cache,now,{text}){false};assertTrue(shown.current())
        commits=false
        assertNull(TargetProgressRepository.load(day,cache,now,{throw SecurityException("SAMPLE refused")}){true}.data)
        assertFalse(shown.current());assertNull(TargetProgressRepository.load(day,cache,now,null){false}.data)
    }
}
