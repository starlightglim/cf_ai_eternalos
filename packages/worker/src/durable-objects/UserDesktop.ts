/**
 * UserDesktop Durable Object
 *
 * Per-user desktop state management. Each user gets one instance
 * that holds their complete desktop: items, positions, folder hierarchy.
 *
 * All state is persisted in Durable Object transactional storage.
 */

import type { Env } from '../index';
import type { DesktopItem, UserProfile, GuestbookConfig, GuestbookEntry } from '../types';
import type { CSSAssetMeta } from '../routes/upload';

// Default storage quota: 100MB per user
export const DEFAULT_QUOTA_BYTES = 100 * 1024 * 1024;

export interface QuotaInfo {
  used: number;      // Bytes used
  limit: number;     // Quota limit in bytes
  remaining: number; // Bytes remaining
  itemCount: number; // Number of items with files
}

/** Minimal window state persisted for visitor mode */
export interface SavedWindowState {
  id: string;
  title: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  zIndex: number;
  minimized: boolean;
  maximized: boolean;
  collapsed?: boolean;
  contentType: string;
  contentId?: string;
}

export class UserDesktop {
  private state: DurableObjectState;
  private env: Env;
  private items: Map<string, DesktopItem> = new Map();
  private profile: UserProfile | null = null;
  private windows: SavedWindowState[] = [];
  private cssAssets: CSSAssetMeta[] = [];
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /**
   * Initialize state from storage on first request
   */
  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load all items from storage
    const storedItems = await this.state.storage.get<DesktopItem[]>('items');
    if (storedItems) {
      for (const item of storedItems) {
        this.items.set(item.id, item);
      }
    }

    // Load profile
    this.profile = await this.state.storage.get<UserProfile>('profile') ?? null;

    // Load saved window state
    this.windows = await this.state.storage.get<SavedWindowState[]>('windows') ?? [];

    // Load CSS assets
    this.cssAssets = await this.state.storage.get<CSSAssetMeta[]>('css-assets') ?? [];

    this.initialized = true;
  }

  /**
   * Handle incoming requests
   */
  async fetch(request: Request): Promise<Response> {
    await this.initialize();

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // WebSocket upgrade for visitor live-sync
      if (path === '/ws' && request.headers.get('Upgrade') === 'websocket') {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        this.state.acceptWebSocket(server);

        // Send initial snapshot to the new visitor
        const snapshot = this.getVisitorData();
        server.send(JSON.stringify({ type: 'snapshot', ...snapshot }));

        return new Response(null, { status: 101, webSocket: client });
      }

      // GET /items - Get all items
      if (path === '/items' && method === 'GET') {
        return Response.json({
          items: Array.from(this.items.values()),
          profile: this.profile,
          windows: this.windows,
        });
      }

      // POST /items - Create new item
      if (path === '/items' && method === 'POST') {
        const item = await request.json() as Partial<DesktopItem>;
        const newItem = await this.createItem(item);
        return Response.json(newItem);
      }

      // PATCH /items - Batch update items
      if (path === '/items' && method === 'PATCH') {
        const patches = await request.json() as Array<{ id: string; updates: Partial<DesktopItem> }>;
        const updated = await this.updateItems(patches);
        return Response.json(updated);
      }

      // DELETE /items/:id - Delete item
      if (path.startsWith('/items/') && method === 'DELETE') {
        const id = path.slice('/items/'.length);
        const deleted = await this.deleteItem(id);
        return Response.json(deleted);
      }

      // GET /public-snapshot - Get public items only
      if (path === '/public-snapshot' && method === 'GET') {
        const snapshot = await this.getPublicSnapshot();
        return Response.json(snapshot);
      }

      // POST /profile - Initialize or update profile (full replace)
      if (path === '/profile' && method === 'POST') {
        const profileData = await request.json() as UserProfile;
        await this.setProfile(profileData);
        return Response.json({ success: true });
      }

      // PATCH /profile - Partial update profile
      if (path === '/profile' && method === 'PATCH') {
        const updates = await request.json() as Partial<UserProfile>;
        const updatedProfile = await this.updateProfile(updates);
        return Response.json({ success: true, profile: updatedProfile });
      }

      // GET /profile - Get profile
      if (path === '/profile' && method === 'GET') {
        return Response.json({ profile: this.profile });
      }

      // PUT /windows - Save window state
      if (path === '/windows' && method === 'PUT') {
        const windowData = await request.json() as SavedWindowState[];
        await this.saveWindows(windowData);
        return Response.json({ success: true });
      }

      // GET /trash - Get trashed items
      if (path === '/trash' && method === 'GET') {
        const trashedItems = await this.getTrashedItems();
        return Response.json({ items: trashedItems });
      }

      // POST /trash/restore/:id - Restore item from trash
      if (path.startsWith('/trash/restore/') && method === 'POST') {
        const id = path.slice('/trash/restore/'.length);
        const restored = await this.restoreFromTrash(id);
        return Response.json(restored);
      }

      // DELETE /trash - Empty trash (permanently delete all trashed items)
      if (path === '/trash' && method === 'DELETE') {
        const deleted = await this.emptyTrash();
        return Response.json(deleted);
      }

      // POST /trash/cleanup - Delete items trashed more than 30 days ago
      if (path === '/trash/cleanup' && method === 'POST') {
        const cleaned = await this.cleanupOldTrash();
        return Response.json(cleaned);
      }

      // GET /quota - Get storage quota usage
      if (path === '/quota' && method === 'GET') {
        const quota = await this.getQuota();
        return Response.json(quota);
      }

      // POST /quota/check - Check if a file of given size would fit
      if (path === '/quota/check' && method === 'POST') {
        const { fileSize } = await request.json() as { fileSize: number };
        const result = await this.checkQuota(fileSize);
        return Response.json(result);
      }

      // GET /css-assets - List CSS assets
      if (path === '/css-assets' && method === 'GET') {
        return Response.json({ assets: this.cssAssets });
      }

      // POST /css-assets - Add CSS asset metadata
      if (path === '/css-assets' && method === 'POST') {
        const meta = await request.json() as CSSAssetMeta;
        this.cssAssets.push(meta);
        await this.state.storage.put('css-assets', this.cssAssets);
        return Response.json({ success: true });
      }

      // DELETE /css-assets/:assetId - Remove CSS asset metadata
      if (path.startsWith('/css-assets/') && method === 'DELETE') {
        const assetId = path.slice('/css-assets/'.length);
        this.cssAssets = this.cssAssets.filter(a => a.assetId !== assetId);
        await this.state.storage.put('css-assets', this.cssAssets);
        return Response.json({ success: true });
      }

      // POST /guestbook/:itemId - Add guestbook entry
      if (path.startsWith('/guestbook/') && method === 'POST') {
        const itemId = path.slice('/guestbook/'.length);
        const entry = await request.json() as { name: string; message: string };
        const result = await this.addGuestbookEntry(itemId, entry);
        if (!result.success) {
          return Response.json({ error: result.error }, { status: 400 });
        }
        return Response.json(result);
      }

      return Response.json({ error: 'Not found' }, { status: 404 });

    } catch (error) {
      console.error('UserDesktop error:', error);
      return Response.json(
        { error: error instanceof Error ? error.message : 'Internal error' },
        { status: 500 }
      );
    }
  }

  /**
   * Create a new desktop item
   * If an ID is provided (e.g., for file uploads), use it; otherwise generate one
   */
  private async createItem(partial: Partial<DesktopItem>): Promise<DesktopItem> {
    const now = Date.now();
    const item: DesktopItem = {
      id: partial.id || crypto.randomUUID(),
      type: partial.type ?? 'folder',
      name: partial.name ?? 'Untitled',
      parentId: partial.parentId ?? null,
      position: partial.position ?? { x: 0, y: 0 },
      isPublic: partial.isPublic ?? true,
      createdAt: now,
      updatedAt: now,
      r2Key: partial.r2Key,
      mimeType: partial.mimeType,
      fileSize: partial.fileSize,
      textContent: partial.textContent,
      url: partial.url,
      customIcon: partial.customIcon,
      widgetType: partial.widgetType,
      widgetConfig: partial.widgetConfig,
      stickerConfig: partial.stickerConfig,
    };

    this.items.set(item.id, item);
    await this.saveItems();
    this.broadcastItems();
    return item;
  }

  /**
   * Batch update items (positions, names, visibility, etc.)
   * Only allows updating safe fields — prevents IDOR attacks that could
   * overwrite r2Key, fileSize, id, or other sensitive fields.
   */
  private async updateItems(
    patches: Array<{ id: string; updates: Partial<DesktopItem> }>
  ): Promise<DesktopItem[]> {
    // Only these fields can be updated via the PATCH endpoint
    const ALLOWED_UPDATE_FIELDS: (keyof DesktopItem)[] = [
      'name',
      'position',
      'parentId',
      'isPublic',
      'textContent',
      'url',
      'customIcon',
      'widgetType',
      'widgetConfig',
      'stickerConfig',
      'isTrashed',
      'trashedAt',
      'originalParentId',
    ];

    const updated: DesktopItem[] = [];

    for (const { id, updates } of patches) {
      const item = this.items.get(id);
      if (item) {
        // Filter updates to only allowed fields
        const filteredUpdates: Partial<DesktopItem> = {};
        for (const field of ALLOWED_UPDATE_FIELDS) {
          if (updates[field] !== undefined) {
            (filteredUpdates as Record<string, unknown>)[field] = updates[field];
          }
        }

        // Prevent circular folder references: if parentId is being changed,
        // walk up the target parent's ancestor chain and ensure this item
        // doesn't appear (which would create a cycle).
        if (
          filteredUpdates.parentId !== undefined &&
          filteredUpdates.parentId !== null &&
          item.type === 'folder'
        ) {
          let ancestor: string | null | undefined = filteredUpdates.parentId as string;
          let isCycle = false;
          const visited = new Set<string>();
          while (ancestor) {
            if (ancestor === id) {
              isCycle = true;
              break;
            }
            if (visited.has(ancestor)) break; // safety against existing cycles
            visited.add(ancestor);
            const parentItem = this.items.get(ancestor);
            ancestor = parentItem?.parentId;
          }
          if (isCycle) {
            // Skip this update — moving a folder into its own descendant
            continue;
          }
        }

        const updatedItem = {
          ...item,
          ...filteredUpdates,
          updatedAt: Date.now(),
        };
        this.items.set(id, updatedItem);
        updated.push(updatedItem);
      }
    }

    if (updated.length > 0) {
      await this.saveItems();
      this.broadcastItems();
    }

    return updated;
  }

  /**
   * Delete an item and all its children (cascade), return r2Keys for cleanup
   */
  private async deleteItem(id: string): Promise<{ deleted: boolean; r2Key?: string; r2Keys?: string[] }> {
    const item = this.items.get(id);
    if (!item) {
      return { deleted: false };
    }

    const r2Keys: string[] = [];

    // Collect this item's r2Key
    if (item.r2Key) {
      r2Keys.push(item.r2Key);
    }

    // Cascade delete: recursively find and delete all children
    const collectChildren = (parentId: string) => {
      for (const [childId, child] of this.items) {
        if (child.parentId === parentId) {
          if (child.r2Key) {
            r2Keys.push(child.r2Key);
          }
          collectChildren(childId); // recurse into subfolders
          this.items.delete(childId);
        }
      }
    };

    // If this is a folder, delete all descendants
    if (item.type === 'folder') {
      collectChildren(id);
    }

    this.items.delete(id);
    await this.saveItems();
    this.broadcastItems();
    this.broadcastWindows();

    return { deleted: true, r2Key: item.r2Key, r2Keys };
  }

  /**
   * Compute public items (non-trashed, not explicitly private)
   */
  private getPublicItemsFiltered(): DesktopItem[] {
    return Array.from(this.items.values()).filter(
      (item) => item.isPublic !== false && !item.isTrashed
    );
  }

  /**
   * Compute visitor-visible data (items, windows, profile) without side effects
   */
  private getVisitorData(): { items: DesktopItem[]; windows: SavedWindowState[]; profile: UserProfile | null } {
    const items = this.getPublicItemsFiltered();
    const publicItemIds = new Set(items.map((i) => i.id));
    const windows = this.windows.filter(
      (w) => !w.contentId || publicItemIds.has(w.contentId)
    );
    return { items, windows, profile: this.profile };
  }

  /**
   * Get visitor-visible items (for visitor mode)
   * Shows all non-trashed items unless explicitly marked private (isPublic === false).
   * Items default to visible — users opt-out by setting isPublic to false.
   */
  private async getPublicSnapshot(): Promise<{
    items: DesktopItem[];
    profile: UserProfile | null;
    windows: SavedWindowState[];
  }> {
    const data = this.getVisitorData();

    // Also push to KV for fast visitor reads (if we have the UID in profile)
    if (this.profile?.uid) {
      await this.env.DESKTOP_KV.put(
        `public:${this.profile.uid}`,
        JSON.stringify(data),
        { expirationTtl: 300 } // Cache for 5 minutes
      );
    }

    return data;
  }

  /**
   * Set user profile (full replace)
   */
  private async setProfile(profile: UserProfile): Promise<void> {
    this.profile = profile;
    await this.state.storage.put('profile', profile);
    this.broadcastProfile();
  }

  /**
   * Update user profile (partial update)
   */
  private async updateProfile(updates: Partial<UserProfile>): Promise<UserProfile | null> {
    if (!this.profile) {
      return null;
    }

    // Only allow updating certain fields
    const allowedFields: (keyof UserProfile)[] = [
      'displayName',
      'wallpaper',
      'accentColor',
      'desktopColor',
      'windowBgColor',
      'fontSmoothing',
      'customCSS',
      'isNewUser',
      'hideWatermark',
      'wallpaperMode',
      'bio',
      'profileLinks',
      'shareDescription',
      'analyticsEnabled',
    ];
    const filteredUpdates: Partial<UserProfile> = {};

    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        (filteredUpdates as Record<string, unknown>)[field] = updates[field];
      }
    }

    // Server-side validation for customCSS
    if (typeof filteredUpdates.customCSS === 'string') {
      const css = filteredUpdates.customCSS;

      // Enforce 50KB limit
      if (css.length > 50 * 1024) {
        throw new Error('Custom CSS exceeds maximum size of 50KB');
      }

      // Block dangerous patterns
      const dangerousPatterns = [
        /@import/i,
        /expression\s*\(/i,
        /javascript:/i,
        /behavior\s*:/i,
        /-moz-binding/i,
        /<script/i,
        /<\/script/i,
      ];
      for (const pattern of dangerousPatterns) {
        if (pattern.test(css)) {
          throw new Error('Custom CSS contains disallowed patterns');
        }
      }

      // Validate url() references — only allow first-party asset paths
      const allowedUrlPrefixes = ['/api/css-assets/', '/api/wallpaper/', '/api/icon/'];
      const urlPattern = /url\s*\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi;
      let urlMatch: RegExpExecArray | null;
      while ((urlMatch = urlPattern.exec(css)) !== null) {
        const urlValue = urlMatch[2];
        if (!allowedUrlPrefixes.some((prefix) => urlValue.startsWith(prefix))) {
          throw new Error('Custom CSS contains disallowed url() references');
        }
      }
    }

    // Validate bio (max 500 chars)
    if (typeof filteredUpdates.bio === 'string') {
      if (filteredUpdates.bio.length > 500) {
        throw new Error('Bio exceeds maximum length of 500 characters');
      }
    }

    // Validate shareDescription (max 200 chars)
    if (typeof filteredUpdates.shareDescription === 'string') {
      if (filteredUpdates.shareDescription.length > 200) {
        throw new Error('Share description exceeds maximum length of 200 characters');
      }
    }

    // Validate profileLinks (max 5, valid URLs)
    if (Array.isArray(filteredUpdates.profileLinks)) {
      if (filteredUpdates.profileLinks.length > 5) {
        throw new Error('Maximum 5 profile links allowed');
      }
      for (const link of filteredUpdates.profileLinks) {
        if (!link.title || typeof link.title !== 'string' || link.title.length > 100) {
          throw new Error('Profile link title must be 1-100 characters');
        }
        if (!link.url || typeof link.url !== 'string') {
          throw new Error('Profile link URL is required');
        }
        try {
          new URL(link.url);
        } catch {
          throw new Error(`Invalid profile link URL: ${link.url}`);
        }
      }
    }

    this.profile = {
      ...this.profile,
      ...filteredUpdates,
    };

    await this.state.storage.put('profile', this.profile);
    this.broadcastProfile();
    return this.profile;
  }

  /**
   * Persist items to DO storage
   */
  private async saveItems(): Promise<void> {
    const itemsArray = Array.from(this.items.values());
    await this.state.storage.put('items', itemsArray);
  }

  /**
   * Save window state to DO storage
   * Only stores essential fields, max 20 windows to prevent abuse.
   */
  private async saveWindows(windowData: SavedWindowState[]): Promise<void> {
    // Limit to 20 windows to prevent storage abuse
    this.windows = windowData.slice(0, 20).map((w) => ({
      id: w.id,
      title: String(w.title || '').slice(0, 200),
      position: { x: Number(w.position?.x) || 0, y: Number(w.position?.y) || 0 },
      size: { width: Number(w.size?.width) || 300, height: Number(w.size?.height) || 200 },
      zIndex: Number(w.zIndex) || 1,
      minimized: Boolean(w.minimized),
      maximized: Boolean(w.maximized),
      collapsed: w.collapsed ? true : undefined,
      contentType: String(w.contentType || 'folder'),
      contentId: w.contentId ? String(w.contentId) : undefined,
    }));
    await this.state.storage.put('windows', this.windows);
    this.broadcastWindows();
  }

  /**
   * Get all trashed items
   */
  private async getTrashedItems(): Promise<DesktopItem[]> {
    return Array.from(this.items.values()).filter((item) => item.isTrashed === true);
  }

  /**
   * Restore an item from trash
   */
  private async restoreFromTrash(id: string): Promise<{ restored: boolean; item?: DesktopItem }> {
    const item = this.items.get(id);
    if (!item || !item.isTrashed) {
      return { restored: false };
    }

    const restoredItem: DesktopItem = {
      ...item,
      isTrashed: false,
      trashedAt: undefined,
      updatedAt: Date.now(),
    };

    this.items.set(id, restoredItem);
    await this.saveItems();
    this.broadcastItems();

    return { restored: true, item: restoredItem };
  }

  /**
   * Empty trash - permanently delete all trashed items and return r2Keys for cleanup
   */
  private async emptyTrash(): Promise<{ deleted: number; r2Keys: string[] }> {
    const trashedItems = Array.from(this.items.values()).filter((item) => item.isTrashed === true);
    const r2Keys: string[] = [];
    let deletedCount = 0;

    for (const item of trashedItems) {
      if (item.r2Key) {
        r2Keys.push(item.r2Key);
      }
      this.items.delete(item.id);
      deletedCount++;
    }

    if (deletedCount > 0) {
      await this.saveItems();
      this.broadcastItems();
    }

    return { deleted: deletedCount, r2Keys };
  }

  /**
   * Cleanup old trashed items - permanently delete items trashed more than 30 days ago
   */
  private async cleanupOldTrash(): Promise<{ deleted: number; r2Keys: string[] }> {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const oldTrashedItems = Array.from(this.items.values()).filter(
      (item) => item.isTrashed === true && item.trashedAt && item.trashedAt < thirtyDaysAgo
    );

    const r2Keys: string[] = [];
    let deletedCount = 0;

    for (const item of oldTrashedItems) {
      if (item.r2Key) {
        r2Keys.push(item.r2Key);
      }
      this.items.delete(item.id);
      deletedCount++;
    }

    if (deletedCount > 0) {
      await this.saveItems();
      this.broadcastItems();
    }

    return { deleted: deletedCount, r2Keys };
  }

  /**
   * Get storage quota usage
   * Calculates total bytes used by summing fileSize of ALL items (including trashed).
   * Trashed items still consume R2 storage until permanently deleted, so they must
   * count toward the quota to prevent the trash-cycling bypass.
   */
  private async getQuota(): Promise<QuotaInfo> {
    let usedBytes = 0;
    let itemCount = 0;

    for (const item of this.items.values()) {
      if (item.fileSize) {
        usedBytes += item.fileSize;
        itemCount++;
      }
    }

    return {
      used: usedBytes,
      limit: DEFAULT_QUOTA_BYTES,
      remaining: Math.max(0, DEFAULT_QUOTA_BYTES - usedBytes),
      itemCount,
    };
  }

  /**
   * Check if there's enough quota for a file of the given size
   */
  public async checkQuota(fileSize: number): Promise<{ allowed: boolean; quota: QuotaInfo }> {
    const quota = await this.getQuota();
    const allowed = (quota.used + fileSize) <= quota.limit;
    return { allowed, quota };
  }

  /**
   * Add a guestbook entry to a widget
   */
  private async addGuestbookEntry(
    itemId: string,
    entry: { name: string; message: string }
  ): Promise<{ success: boolean; error?: string; entries?: GuestbookEntry[] }> {
    const item = this.items.get(itemId);

    if (!item) {
      return { success: false, error: 'Widget not found' };
    }

    if (item.type !== 'widget' || item.widgetType !== 'guestbook') {
      return { success: false, error: 'Item is not a guestbook widget' };
    }

    if (!item.isPublic) {
      return { success: false, error: 'Guestbook is not public' };
    }

    // Get current config
    const currentConfig = (item.widgetConfig || { entries: [] }) as GuestbookConfig;
    const entries = currentConfig.entries || [];

    // Add new entry — trim + truncate; XSS prevention handled by React's
    // automatic JSX escaping on the frontend render path
    const newEntry: GuestbookEntry = {
      name: entry.name.trim().slice(0, 50),
      message: entry.message.trim().slice(0, 500),
      timestamp: Date.now(),
    };

    const updatedEntries = [...entries, newEntry];

    // Keep max 100 entries to prevent unbounded growth
    const trimmedEntries = updatedEntries.slice(-100);

    // Update item
    const updatedConfig: GuestbookConfig = { entries: trimmedEntries };
    const updatedItem: DesktopItem = {
      ...item,
      widgetConfig: updatedConfig,
      updatedAt: Date.now(),
    };

    this.items.set(itemId, updatedItem);
    await this.saveItems();
    this.broadcastItems();

    return { success: true, entries: trimmedEntries };
  }

  // --- WebSocket live-sync broadcast helpers ---

  /** Send a JSON message to all connected visitor WebSockets */
  private broadcastToVisitors(data: Record<string, unknown>): void {
    const message = JSON.stringify(data);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(message);
      } catch {
        // WebSocket already closed, will be cleaned up
      }
    }
  }

  /** Broadcast current public items to all visitors */
  private broadcastItems(): void {
    if (this.state.getWebSockets().length === 0) return;
    const items = this.getPublicItemsFiltered();
    this.broadcastToVisitors({ type: 'items', items });
  }

  /** Broadcast current public windows to all visitors */
  private broadcastWindows(): void {
    if (this.state.getWebSockets().length === 0) return;
    const publicItems = this.getPublicItemsFiltered();
    const publicItemIds = new Set(publicItems.map((i) => i.id));
    const windows = this.windows.filter(
      (w) => !w.contentId || publicItemIds.has(w.contentId)
    );
    this.broadcastToVisitors({ type: 'windows', windows });
  }

  /** Broadcast profile to all visitors */
  private broadcastProfile(): void {
    if (this.state.getWebSockets().length === 0) return;
    this.broadcastToVisitors({ type: 'profile', profile: this.profile });
  }

  // --- WebSocket hibernation handlers ---

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Visitors are read-only, ignore all incoming messages
  }

  async webSocketClose(ws: WebSocket, code: number, _reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, 'Connection closed');
  }

  async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Error will trigger close, handled by webSocketClose
  }
}
