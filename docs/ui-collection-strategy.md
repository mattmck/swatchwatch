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
- **Status chip** (#262): Owned / Wishlist / Destash / Archived, or "Not added" for catalog-only rows, plus an **Untried** badge for owned polishes with no tried date.
- **Quick actions:**
  - If owned: [ - ] [quantity] [ + ] buttons to adjust quantity. Removing the last bottle moves the polish to **Archived** (used up), not the wishlist.
  - If not owned: ♡ (wishlist toggle; un-hearting removes the wishlist entry) and ✓ Own (owned with at least one bottle).
  - ⋯ menu: move to any status; mark tried today / on a date / as untried.
- **Immediate, in-place actions** (no need to open a detail page), optimistic with rollback and an error toast on failure

### 3. Search & Filtering Toggles
- **Status presets:** All / My Collection / Wishlist, plus a multi-select status menu and an **Untried** toggle (URL: `status=owned,destash&untried=1`)
- **Include All:** Shows all polishes, regardless of ownership (the "All" preset)
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
| Owned · Untried | OPI | Lincoln Park After Dark | 🟣 | Creme | Fall 2022 | [ - ] 2 [ + ] ⋯ |
| Not added | Essie | Ballet Slippers | 🩰 | Sheer | Core | ♡ [✓ Own] ⋯ |

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
