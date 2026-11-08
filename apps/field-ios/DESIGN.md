# Field iOS design (SP-0166)

Mode: **Operate**. Sellers use the app all day, outdoors, often one-handed. Fast, scannable, big targets, legible in sun.

## Navigation
- **Bottom bar on every device**, the same places as the Android field app (`FieldNav.kt`):
  **Today · Route · Stores · More**. Android also has Messages; iOS has no chat screen yet, so the tab is left out rather than shown empty. Add it here when chat ships on iOS.
- **iPhone**: the system `TabView` (Liquid Glass, automatic). Portrait only.
- **iPad**: the system tab bar sits at the top, so the app draws its own floating Liquid Glass bar at the bottom (`FloatingTabBar`: `GlassEffectContainer` + `.glassEffect(.regular.interactive())`, 96×56pt items, selected item in Sunpride red). Portrait and landscape. The bar's height is reserved with a bottom safe-area inset, and it steps aside when the keyboard is up.
- **iPad landscape, Stores**: list beside detail (`NavigationSplitView`, balanced).
- Forms and an open visit hide the bar (`.fieldTabBarHidden()`, like Android's `noBarPages`), so a tap can't pull the seller out mid-entry. Screens pushed on top of a visit keep it hidden on iPad.
- Where each screen lives: Today (dashboard, start/end day, visits, team link, sync/account pills) · Route (MCP stops, directions) · Stores (search, store detail, **Add a store** button top right, also offered when a search finds nothing) · More (Account, Sync, Support info, Add a store, Team for supervisors).

## Visual
- Tokens live in `SunprideTokens` (brand red, darkened action red `#B4151D` for text and contrast, adaptive light/dark).
- Glass is used only on navigation and controls (tab bars, account button, Add a store), never on content cards. Content stays on opaque cards for contrast in sunlight.
- SF Symbols, system text styles (Dynamic Type), and 44–56pt minimum targets.
