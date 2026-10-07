package com.sunpride.van.pos

import com.sunpride.van.data.*
import com.sunpride.van.ui.VanRules
import org.junit.Assert.*
import org.junit.Test

class ReturnRulesTest {
    private val juice = Product("p1","SP-PJ-1L","Pineapple Juice 1L","PC",1,listOf("4800000000017","14800000000016"),
        listOf(BarcodeUnit("4800000000017","PC",1),BarcodeUnit("14800000000016","CS",24)))
    private val chunks = Product("p2","SP-PC-432","Pineapple Chunks 432g","PC",1,emptyList())
    /** Sold by the kilogram, stored in grams. */
    private val bulk = Product("p3","SP-BULK","Dried Pineapple","KG",1000,emptyList())
    private val route = Customer("o1","O-1001","Aling Nena Store",null,1,"route")
    private val other = Customer("o2","O-1002","JM Sari-Sari",null,2,"route")
    private val walkIn = Customer("local:w1","","Corner Store",null,null,"walk_in","Not on list",true)
    private val returnId = "6f1c1f3e-2b7a-4c55-9d1e-0c4b8f7a1a02"
    private val sale = SoldSale("s1","TRIP-1-ABCDEF01-0001","o1",1L,mapOf("p1" to 48L,"p3" to 2_000L))
    private fun context(open: Boolean = true, returned: Map<String,Map<String,Long>> = emptyMap()) =
        ReturnContext(open,listOf(route,other,walkIn),listOf(juice,chunks,bulk),listOf(sale),returned)
    private fun line(product: String = "p1", qty: Long = 2, reason: String? = "damaged", disposition: ReturnDisposition? = ReturnDisposition.BAD_STOCK,
        uom: String = "PC", lot: String? = null, expiry: String? = null) = ReturnLineInput(product,uom,qty,reason,disposition,lot,expiry)
    private fun request(vararg lines: ReturnLineInput, customer: String? = "o1", saleId: String? = "s1", note: String? = null) =
        ReturnRequest(returnId,customer,saleId,lines.toList(),note)
    private fun problems(r: ReturnResult) = r.issues.map { it.problem }.toSet()

    @Test fun badOrderLinkedToASaleGoesToDamagedStockWithoutApproval() {
        val r = ReturnRules.evaluate(request(line(qty = 3)),context())
        assertTrue(r.issues.toString(),r.ok)
        val q = r.quote!!
        assertFalse(q.approvalRequired)
        assertEquals(ReturnStockEffect.DAMAGED,q.lines.single().stockEffect)
        assertEquals(mapOf(("p1" to ReturnStockEffect.DAMAGED) to 3L),q.stockChanges)
        assertEquals("s1",q.sale!!.saleId)
    }
    @Test fun goodStockFromASaleReturnsToSellableStock() {
        val q = ReturnRules.evaluate(request(line(reason = "wrong_item",disposition = ReturnDisposition.RESELLABLE)),context()).quote!!
        assertFalse(q.approvalRequired)
        assertEquals(ReturnStockEffect.AVAILABLE,q.lines.single().stockEffect)
    }
    @Test fun goodsWaitingForApprovalAreHeldNeverSellable() {
        // Not linked to a sale on this phone: the office must approve, and resellable goods stay out of available stock.
        val q = ReturnRules.evaluate(request(line(reason = "wrong_item",disposition = ReturnDisposition.RESELLABLE),saleId = null),context()).quote!!
        assertEquals(listOf(ReturnApprovalReason.NOT_LINKED_TO_SALE),q.approvalReasons)
        assertEquals(ReturnStockEffect.DAMAGED,q.lines.single().stockEffect)
        // Near-expiry resale always needs approval, even from a receipt here.
        val near = ReturnRules.evaluate(request(line(reason = "near_expiry",disposition = ReturnDisposition.RESELLABLE,lot = "L1")),context()).quote!!
        assertEquals(listOf(ReturnApprovalReason.POLICY),near.approvalReasons)
        assertEquals(ReturnStockEffect.DAMAGED,near.lines.single().stockEffect)
        // A walk-in return needs approval.
        val walk = ReturnRules.evaluate(request(line(),customer = "local:w1",saleId = null),context()).quote!!
        assertEquals(listOf(ReturnApprovalReason.NOT_LINKED_TO_SALE,ReturnApprovalReason.WALK_IN),walk.approvalReasons)
    }
    @Test fun goodsThrownAwayAtTheStoreMoveNoStockAndNeedApproval() {
        val q = ReturnRules.evaluate(request(line(reason = "spoiled",disposition = ReturnDisposition.DISPOSED_AT_OUTLET,lot = "lot 7a")),context()).quote!!
        assertEquals(listOf(ReturnApprovalReason.DISPOSED_AT_OUTLET),q.approvalReasons)
        assertEquals(ReturnStockEffect.NONE,q.lines.single().stockEffect)
        assertTrue(q.stockChanges.isEmpty())
        assertEquals("LOT 7A",q.lines.single().lotNumber)
    }
    @Test fun dispositionMustBeAllowedForTheReason() {
        assertEquals(setOf(ReturnProblem.DISPOSITION_NOT_ALLOWED),problems(ReturnRules.evaluate(request(line(reason = "expired",disposition = ReturnDisposition.RESELLABLE,lot = "L1")),context())))
        assertEquals(setOf(ReturnProblem.NO_REASON),problems(ReturnRules.evaluate(request(line(reason = null)),context())))
        assertEquals(setOf(ReturnProblem.NO_REASON),problems(ReturnRules.evaluate(request(line(reason = "made_up")),context())))
        assertEquals(setOf(ReturnProblem.NO_DISPOSITION),problems(ReturnRules.evaluate(request(line(disposition = null)),context())))
    }
    @Test fun batchIsRequiredForDateAndQualityReasonsAndExpiryMustBeADate() {
        assertEquals(setOf(ReturnProblem.BATCH_MISSING),problems(ReturnRules.evaluate(request(line(reason = "expired")),context())))
        assertEquals(setOf(ReturnProblem.BATCH_INVALID),problems(ReturnRules.evaluate(request(line(lot = "LOT#1")),context())))
        assertEquals(setOf(ReturnProblem.EXPIRY_INVALID),problems(ReturnRules.evaluate(request(line(expiry = "31/10/2026")),context())))
        val ok = ReturnRules.evaluate(request(line(reason = "expired",lot = " lot-2026 / 01 ",expiry = "2026-09-30")),context()).quote!!.lines.single()
        assertEquals("LOT-2026 / 01",ok.lotNumber); assertEquals("2026-09-30",ok.expiryDate)
    }
    @Test fun casesCountInWholeCasesAndTheProductUnitMayBeFractional() {
        val q = ReturnRules.evaluate(request(line(uom = "CS",qty = 48)),context()).quote!!
        assertEquals("2",q.lines.single().unitQuantity); assertEquals("CS",q.lines.single().unit.uomCode)
        assertEquals(setOf(ReturnProblem.BAD_QUANTITY),problems(ReturnRules.evaluate(request(line(uom = "CS",qty = 30)),context())))
        assertEquals(setOf(ReturnProblem.UNKNOWN_UNIT),problems(ReturnRules.evaluate(request(line(uom = "BOX")),context())))
        assertEquals(setOf(ReturnProblem.BAD_QUANTITY),problems(ReturnRules.evaluate(request(line(qty = 0)),context())))
        // 1.5 KG of the bulk product = 1500 g base.
        val kg = ReturnRules.evaluate(request(line(product = "p3",uom = "KG",qty = VanRules.parseQuantity("1.5",1000)!!)),context()).quote!!
        assertEquals("1.5",kg.lines.single().unitQuantity)
        assertEquals(listOf(ReturnUnit("PC",1),ReturnUnit("CS",24)),ReturnRules.units(juice))
    }
    @Test fun aLinkedReturnNeverExceedsWhatTheSaleSold() {
        assertEquals(setOf(ReturnProblem.MORE_THAN_SOLD),problems(ReturnRules.evaluate(request(line(qty = 30),line(qty = 19,reason = "expired",lot = "L1")),context())))
        assertTrue(ReturnRules.evaluate(request(line(qty = 30),line(qty = 18,reason = "expired",lot = "L1")),context()).ok)
        // Earlier returns against the same receipt count.
        assertEquals(setOf(ReturnProblem.MORE_THAN_SOLD),problems(ReturnRules.evaluate(request(line(qty = 2)),context(returned = mapOf("s1" to mapOf("p1" to 47L))))))
        assertEquals(setOf(ReturnProblem.NOT_ON_SALE),problems(ReturnRules.evaluate(request(line(product = "p2")),context())))
        assertEquals(setOf(ReturnProblem.SALE_OTHER_CUSTOMER),problems(ReturnRules.evaluate(request(line(),customer = "o2"),context())))
        assertEquals(setOf(ReturnProblem.UNKNOWN_SALE),problems(ReturnRules.evaluate(request(line(),saleId = "gone"),context())))
        // Without a linked sale there is no cap, but approval is required.
        assertTrue(ReturnRules.evaluate(request(line(product = "p2",qty = 500),saleId = null),context()).ok)
    }
    @Test fun headerChecks() {
        assertTrue(ReturnProblem.TRIP_NOT_OPEN in problems(ReturnRules.evaluate(request(line()),context(open = false))))
        assertTrue(ReturnProblem.NO_CUSTOMER in problems(ReturnRules.evaluate(request(line(),customer = null,saleId = null),context())))
        assertTrue(ReturnProblem.UNKNOWN_CUSTOMER in problems(ReturnRules.evaluate(request(line(),customer = "zz",saleId = null),context())))
        assertEquals(setOf(ReturnProblem.EMPTY),problems(ReturnRules.evaluate(request(),context())))
        assertEquals(setOf(ReturnProblem.UNKNOWN_PRODUCT),problems(ReturnRules.evaluate(request(line(product = "nope")),context())))
        assertEquals(setOf(ReturnProblem.NOTE_INVALID),problems(ReturnRules.evaluate(request(line(),note = "x".repeat(301)),context())))
        assertEquals(setOf(ReturnProblem.DUPLICATE_LINE),problems(ReturnRules.evaluate(request(line(),line()),context())))
        // Same product, different batch: two lines are fine.
        assertTrue(ReturnRules.evaluate(request(line(lot = "A"),line(lot = "B")),context()).ok)
        val many = (1..51).map { line(lot = "L$it",qty = 1) }.toTypedArray()
        assertTrue(ReturnProblem.TOO_MANY_LINES in problems(ReturnRules.evaluate(request(*many,saleId = null),context())))
        assertThrows(IllegalArgumentException::class.java) { ReturnRules.evaluate(request(line()).copy(returnId = "not-a-uuid"),context()) }
    }
    @Test fun everyProblemHasPlainWords() {
        ReturnProblem.entries.forEach { assertTrue(VanRules.returnMessage(it,"Juice").isNotBlank()) }
        ReturnApprovalReason.entries.forEach { assertTrue(VanRules.approvalLabel(it).isNotBlank()) }
    }
    @Test fun captureComparesEveryDetailAsItIsSaved() {
        val line = ReturnLineInput("p1","PC",2,"expired",ReturnDisposition.BAD_STOCK," lot  7a ","2027-01-31")
        val r = ReturnRequest("1b4e28ba-2fa1-41d2-883f-0016d3cca427","o1","s1",listOf(line)," note ")
        val saved = ReturnCapture("o1","s1","note",listOf(ReturnCapture.Line("p1","PC",2,"expired","bad_stock","LOT 7A","2027-01-31")))
        assertEquals(saved,ReturnCapture.of(r))
        assertNotEquals(saved,ReturnCapture.of(r.copy(lines = listOf(line.copy(disposition = ReturnDisposition.DISPOSED_AT_OUTLET)))))
        assertNotEquals(saved,ReturnCapture.of(r.copy(lines = listOf(line.copy(uomCode = "CS")))))
        assertNotEquals(saved,ReturnCapture.of(r.copy(lines = listOf(line.copy(lotNumber = null)))))
        assertNotEquals(saved,ReturnCapture.of(r.copy(lines = listOf(line.copy(expiryDate = "2027-02-01")))))
        assertNotEquals(saved,ReturnCapture.of(r.copy(originalSaleId = null)))
        assertNotEquals(saved,ReturnCapture.of(r.copy(note = null)))
    }
}
