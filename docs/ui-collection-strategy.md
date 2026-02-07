# SwatchWatch — All Polishes/Collection UI Strategy

## Overview

This document describes the UI/UX strategy for the "All Polishes" (Collection) page, enabling users to manage their nail polish inventory efficiently and intuitively. This approach is designed for advanced collection management and is suitable for implementation by any agent or developer.

---

## Key Features

### 1. Unified Catalog & Inventory Table
- The Collection page displays **all polishes in the canonical database**, not just those owned by the user.
- The table is **paged** for performance and usability.
- Each row represents a polish, with columns for brand, name, color swatch, finish, collection, and user-specific controls.

### 2. Inventory Controls Per Row
- **Status Icon:**
  - ✔️ (checkmark) if the user owns the polish (quantity > 0)
  - ➕ (plus) if not owned
- **Quantity Controls:**
  - If owned: [ - ] [quantity] [ + ] buttons to adjust quantity
  - If not owned: [Add] button to add to collection (sets quantity to 1)
- **Immediate, in-place actions** (no need to open a detail page)

### 3. Search & Filtering Toggles
- **Favor My Collection:** Prioritizes polishes the user owns in search results
- **Include All:** Shows all polishes, regardless of ownership
- **Similar / Complementary:** Toggles for advanced search modes (e.g., color similarity, complementary shades)
- **Search bar** for text-based filtering

### 4. Consistent UX Across Collection and Search
- The same table structure and controls are used in both the Collection and Search pages.
- The "Have it" column always shows the user's inventory status and controls.

### 5. Paging & Performance
- Use paging and/or virtualization for large catalogs
- All actions are optimistic and provide instant feedback

---

## Implementation Notes
- **Backend:**
  - API should return all polishes, with user inventory status (quantity, notes) joined per row
  - Endpoints for add, increment, decrement, and remove inventory items
- **Frontend:**
  - Table/grid component with status icon, quantity controls, and Add button
  - Search bar and toggle controls above the table
  - Responsive design for desktop and mobile
  - Accessibility: all controls keyboard and screen reader accessible
- **Design:**
  - Light mode and dark mode variants
  - Clear, modern, and minimal visual style

---

## Example Row
| ✔️ | OPI | Lincoln Park After Dark | 🟣 | Creme | Fall 2022 | [ - ] 2 [ + ] |
| ➕ | Essie | Ballet Slippers | 🩰 | Sheer | Core | [Add] |

---

## SVG/Figma Asset
- See `apps/web/ui-preview-collection-light.svg` for a Figma-ready static preview of the intended UI.

---

## Rationale
- This strategy is based on best practices from leading collection and inventory apps (e.g., Goodreads, Discogs, Steam, BoardGameGeek).
- It minimizes navigation friction, supports both casual and power users, and is scalable to large catalogs.

---

## For Agents
- When asked to implement or update the Collection or Search UI, follow this strategy for layout, controls, and user flows.
- Always ensure performance, accessibility, and visual clarity.
