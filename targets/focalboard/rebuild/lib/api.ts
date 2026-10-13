// The /api/v2 routes: accounts and sessions, the single team, templates, categories, boards, blocks
// and members. Every change is pushed over the socket (lib/ws.ts) to the users who may see it.

import { hashPassword, newSessionToken, verifyPassword } from './auth.ts';
import { type Block, type Board, type CardOption, type CardProperty, type Category, type Member, type Store, type User, newId } from './store.ts';
import { forgetToken, publish } from './ws.ts';

export const TEAM_ID = '0';
const CATEGORY_NAME = 'My boards';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface ApiRequest {
  method: string;
  /** The path after /api/v2, e.g. `/boards/b123/blocks`. */
  path: string;
  query: URLSearchParams;
  body: unknown;
  token: string | undefined;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

interface Ctx {
  req: ApiRequest;
  params: string[];
  user: User;
}

type Handler = (ctx: Ctx) => unknown;
type PublicHandler = (req: ApiRequest) => unknown;

// ---- small input helpers -------------------------------------------------------------------

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const bool = (v: unknown, fallback = false): boolean => (typeof v === 'boolean' ? v : fallback);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const obj = (v: unknown): Obj => (isObj(v) ? structuredClone(v) : {});

function bodyObject(req: ApiRequest): Obj {
  if (!isObj(req.body)) throw new ApiError(400, 'The request body must be a JSON object.');
  return req.body;
}

function bodyArray(req: ApiRequest): unknown[] {
  if (!Array.isArray(req.body)) throw new ApiError(400, 'The request body must be a JSON array.');
  return req.body;
}

/** Strictly increasing clock, so two writes never share a time. */
let lastNow = 0;
function now(): number {
  lastNow = Math.max(Date.now(), lastNow + 1);
  return lastNow;
}

const idKind = (type: string) => (type === 'card' ? 'c' : type === 'view' ? 'v' : type === 'board' ? 'b' : 'a');

function cardOptions(v: unknown): CardOption[] {
  return (Array.isArray(v) ? v : []).filter(isObj).map((o) => ({ id: str(o.id) || newId('a'), value: str(o.value), color: str(o.color, 'propColorDefault') }));
}

function cardProperties(v: unknown): CardProperty[] {
  return (Array.isArray(v) ? v : []).filter(isObj).map((p) => ({ id: str(p.id) || newId('a'), name: str(p.name), type: str(p.type, 'text'), options: cardOptions(p.options) }));
}

// ---- the API -------------------------------------------------------------------------------

export class Api {
  private readonly store: Store;
  private readonly routes: [method: string, pattern: RegExp, handler: Handler][] = [];
  private readonly publicRoutes: [method: string, pattern: RegExp, handler: PublicHandler][] = [];

  constructor(store: Store) {
    this.store = store;
    if (!store.getMeta('signupToken')) store.setMeta('signupToken', newId('t'));
    if (!store.getMeta('teamUpdateAt')) store.setMeta('teamUpdateAt', String(Date.now()));

    const open = (method: string, pattern: RegExp, handler: PublicHandler) => this.publicRoutes.push([method, pattern, handler]);
    const route = (method: string, pattern: RegExp, handler: Handler) => this.routes.push([method, pattern, handler]);

    open('GET', /^\/clientConfig$/, () => ({ telemetry: false, telemetryid: '', enablePublicSharedBoards: false, teammateNameDisplay: 'username', featureFlags: {}, maxFileSize: 0 }));
    open('POST', /^\/register$/, (req) => this.register(req));
    open('POST', /^\/login$/, (req) => this.login(req));

    route('POST', /^\/logout$/, ({ req }) => {
      if (req.token) {
        this.store.deleteSession(req.token);
        forgetToken(req.token);
      }
      return {};
    });
    route('GET', /^\/users\/me$/, ({ user }) => user);
    route('GET', /^\/users\/me\/config$/, () => []);
    route('GET', /^\/users\/me\/memberships$/, ({ user }) => this.store.membershipsOf(user.id));
    route('GET', /^\/users\/([^/]+)$/, ({ params }) => this.store.userById(params[0]!) ?? notFound('user'));
    route('POST', /^\/users$/, ({ req }) => bodyArray(req).flatMap((id) => (typeof id === 'string' ? (this.store.userById(id) ?? []) : [])));
    route('GET', /^\/limits$/, () => ({ cards: 0, used_cards: 0, card_limit_timestamp: 0, views: 0 }));

    route('GET', /^\/teams$/, () => [this.team()]);
    route('GET', /^\/teams\/([^/]+)$/, ({ params }) => (this.checkTeam(params[0]!), this.team()));
    route('GET', /^\/teams\/([^/]+)\/users$/, ({ params, req }) => {
      this.checkTeam(params[0]!);
      const search = (req.query.get('search') ?? '').toLowerCase();
      return this.store.listUsers().filter((u) => !(req.query.get('exclude_bots') === 'true' && u.is_bot) && (!search || u.username.toLowerCase().includes(search)));
    });
    route('GET', /^\/teams\/([^/]+)\/boards$/, ({ params, user }) => (this.checkTeam(params[0]!), this.store.boardsForUser(user.id, params[0]!)));
    route('GET', /^\/teams\/([^/]+)\/templates$/, ({ params }) => (this.checkTeam(params[0]!), this.store.templates(params[0]!)));
    route('GET', /^\/teams\/([^/]+)\/categories$/, ({ params, user }) => {
      this.checkTeam(params[0]!);
      this.systemCategory(user.id, params[0]!);
      return this.store.categoriesOf(user.id, params[0]!).map((c) => this.categoryOut(c));
    });

    route('POST', /^\/boards-and-blocks$/, (ctx) => this.createBoardsAndBlocks(ctx));
    route('PATCH', /^\/boards\/([^/]+)$/, (ctx) => this.patchBoard(ctx));
    route('GET', /^\/boards\/([^/]+)\/blocks$/, ({ params, req, user }) => {
      const board = this.readableBoard(params[0]!, user);
      const parent = req.query.get('parent_id');
      const type = req.query.get('type');
      return this.store.blocksOf(board.id).filter((b) => (!parent || b.parentId === parent) && (!type || b.type === type));
    });
    route('POST', /^\/boards\/([^/]+)\/blocks$/, (ctx) => this.createBlocks(ctx));
    route('PATCH', /^\/boards\/([^/]+)\/blocks\/([^/]+)$/, (ctx) => this.patchBlock(ctx));
    route('DELETE', /^\/boards\/([^/]+)\/blocks\/([^/]+)$/, (ctx) => this.deleteBlock(ctx));
    route('GET', /^\/boards\/([^/]+)\/members$/, ({ params, user }) => this.store.membersOf(this.readableBoard(params[0]!, user).id));
    route('POST', /^\/boards\/([^/]+)\/join$/, (ctx) => this.join(ctx));
  }

  handle(req: ApiRequest): ApiResponse {
    try {
      for (const [method, pattern, handler] of this.publicRoutes) if (method === req.method && pattern.test(req.path)) return { status: 200, body: handler(req) };
      let allowed: string[] = [];
      for (const [method, pattern, handler] of this.routes) {
        const m = pattern.exec(req.path);
        if (!m) continue;
        if (method !== req.method) {
          allowed.push(method);
          continue;
        }
        const user = this.userForToken(req.token);
        if (!user) throw new ApiError(401, req.token ? 'The session has ended. Sign in again.' : 'Sign in first: no session token was sent.');
        allowed = [];
        return { status: 200, body: handler({ req, params: m.slice(1).map((p) => decodeURIComponent(p)), user }) };
      }
      if (allowed.length) throw new ApiError(405, `Use ${allowed.join(' or ')} for this address.`);
      throw new ApiError(404, 'There is nothing at this address.');
    } catch (error) {
      if (error instanceof ApiError) return { status: error.status, body: { error: error.message, errorCode: error.status } };
      throw error;
    }
  }

  userForToken(token: string | undefined): User | undefined {
    const userId = token ? this.store.sessionUserId(token) : undefined;
    return userId ? this.store.userById(userId) : undefined;
  }

  // ---- accounts ----------------------------------------------------------------------------

  private register(req: ApiRequest): unknown {
    const body = bodyObject(req);
    const username = str(body.username).trim();
    const email = str(body.email).trim();
    const password = str(body.password);
    if (this.store.userCount() > 0 && str(body.token) !== this.store.getMeta('signupToken')) throw new ApiError(401, 'Sign-up is closed: an account exists already, so a team invitation is needed.');
    if (!/^[\w.@-]{1,64}$/.test(username)) throw new ApiError(400, 'Choose a username of up to 64 letters, digits, dots, dashes or underscores.');
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new ApiError(400, 'Enter a valid email address.');
    if (password.length < 8) throw new ApiError(400, 'Choose a password of at least 8 characters.');
    if (this.store.usernameOrEmailTaken(username, email)) throw new ApiError(400, 'That username or email address is already in use.');
    const at = now();
    const user: User = { id: newId('u'), username, nickname: '', firstname: '', lastname: '', create_at: at, update_at: at, delete_at: 0, is_bot: false, is_guest: false, roles: '' };
    this.store.insertUser(user, email, hashPassword(password));
    return {};
  }

  private login(req: ApiRequest): unknown {
    const body = bodyObject(req);
    const type = str(body.type, 'normal');
    if (type !== 'normal') throw new ApiError(400, 'Only username and password sign-in is supported.');
    const found = this.store.userForLogin(str(body.username).trim() || str(body.email).trim());
    if (!found || !verifyPassword(str(body.password), found.passwordHash)) throw new ApiError(401, 'The username or password is not right.');
    const token = newSessionToken();
    this.store.createSession(token, found.user.id);
    return { token };
  }

  // ---- team and categories -----------------------------------------------------------------

  private team(): unknown {
    return { id: TEAM_ID, title: '', signupToken: this.store.getMeta('signupToken') ?? '', settings: {}, modifiedBy: '', updateAt: Number(this.store.getMeta('teamUpdateAt')) };
  }

  private checkTeam(teamId: string): void {
    if (teamId !== TEAM_ID) throw new ApiError(404, 'There is no such team.');
  }

  private categoryOut(c: Category): unknown {
    const { sortOrder, ...rest } = c;
    return { ...rest, boardMetadata: this.store.boardMetadata(c.id), sortOrder };
  }

  /** The user's system category, created (and announced) the first time it is needed. */
  private systemCategory(userId: string, teamId: string): Category {
    const existing = this.store.categoriesOf(userId, teamId).find((c) => c.type === 'system');
    if (existing) return existing;
    const at = now();
    const category: Category = { id: newId('7'), name: CATEGORY_NAME, userID: userId, teamID: teamId, createAt: at, updateAt: at, deleteAt: 0, collapsed: false, sorting: '', type: 'system', sortOrder: 0 };
    this.store.putCategory(category);
    publish(teamId, { action: 'UPDATE_CATEGORY', category }, (uid) => uid === userId);
    return category;
  }

  // ---- boards ------------------------------------------------------------------------------

  private canSee(board: Board): (userId: string) => boolean {
    return (userId) => board.isTemplate || !!this.store.getMember(board.id, userId);
  }

  private readableBoard(boardId: string, user: User): Board {
    const board = this.store.getBoard(boardId);
    if (!board || board.deleteAt) throw notFound('board');
    if (!this.canSee(board)(user.id)) throw new ApiError(403, 'You are not a member of this board.');
    return board;
  }

  private writableBoard(boardId: string, user: User): Board {
    const board = this.readableBoard(boardId, user);
    const member = this.store.getMember(board.id, user.id);
    if (!member || !(member.schemeAdmin || member.schemeEditor)) throw new ApiError(403, 'You may not change this board.');
    return board;
  }

  private pushBoard(board: Board): void {
    publish(board.teamId, { action: 'UPDATE_BOARD', board }, this.canSee(board));
  }

  private pushBlock(board: Board, block: Block): void {
    publish(board.teamId, { action: 'UPDATE_BLOCK', block }, this.canSee(board));
  }

  private createBoardsAndBlocks({ req, user }: Ctx): unknown {
    const body = bodyObject(req);
    if (!Array.isArray(body.boards) || !Array.isArray(body.blocks)) throw new ApiError(400, 'Send both "boards" and "blocks" as lists.');
    const inputs = body.boards.filter(isObj);
    if (!inputs.length) throw new ApiError(400, 'Send at least one board.');
    const ids = new Map<string, string>();
    const at = now();
    const boards = inputs.map((b) => {
      const teamId = str(b.teamId, TEAM_ID);
      this.checkTeam(teamId);
      const board: Board = {
        id: newId('b'),
        teamId,
        channelId: str(b.channelId),
        createdBy: user.id,
        modifiedBy: user.id,
        type: b.type === 'O' ? 'O' : 'P',
        minimumRole: str(b.minimumRole),
        title: str(b.title),
        description: str(b.description),
        icon: str(b.icon),
        showDescription: bool(b.showDescription),
        isTemplate: bool(b.isTemplate),
        templateVersion: num(b.templateVersion),
        properties: obj(b.properties),
        cardProperties: cardProperties(b.cardProperties),
        createAt: at,
        updateAt: at,
        deleteAt: 0,
      };
      if (typeof b.id === 'string') ids.set(b.id, board.id);
      return board;
    });
    const blockInputs = body.blocks.filter(isObj);
    for (const b of blockInputs) {
      const boardId = ids.get(str(b.boardId));
      if (!boardId) throw new ApiError(400, 'Every block must belong to one of the boards sent with it.');
    }
    const blocks = this.newBlocks(blockInputs, (b) => ids.get(str(b.boardId))!, user, ids);
    const members: Member[] = boards.map((board) => ({ boardId: board.id, userId: user.id, roles: '', minimumRole: '', schemeAdmin: true, schemeEditor: true, schemeCommenter: false, schemeViewer: false, synthetic: false }));
    this.store.transaction(() => {
      for (const board of boards) this.store.putBoard(board);
      for (const block of blocks) this.store.putBlock(block);
      for (const member of members) this.store.putMember(member);
    });
    for (const [i, board] of boards.entries()) {
      this.pushBoard(board);
      for (const block of blocks) if (block.boardId === board.id) this.pushBlock(board, block);
      publish(board.teamId, { action: 'UPDATE_MEMBER', member: members[i] }, this.canSee(board));
      if (!board.isTemplate) {
        const category = this.systemCategory(user.id, board.teamId);
        this.store.fileBoard(category.id, board.id);
        publish(board.teamId, { action: 'UPDATE_BOARD_CATEGORY', blockCategories: [{ boardID: board.id, categoryID: category.id, hidden: false }] }, (uid) => uid === user.id);
      }
    }
    return { boards, blocks };
  }

  private patchBoard({ req, params, user }: Ctx): unknown {
    const board = this.writableBoard(params[0]!, user);
    const body = bodyObject(req);
    for (const key of ['title', 'description', 'icon', 'channelId', 'minimumRole'] as const) if (typeof body[key] === 'string') board[key] = body[key];
    if (body.type === 'O' || body.type === 'P') board.type = body.type;
    if (typeof body.showDescription === 'boolean') board.showDescription = body.showDescription;
    if (isObj(body.updatedProperties)) Object.assign(board.properties, structuredClone(body.updatedProperties));
    if (Array.isArray(body.deletedProperties)) for (const key of body.deletedProperties) if (typeof key === 'string') delete board.properties[key];
    for (const prop of cardProperties(body.updatedCardProperties)) {
      const i = board.cardProperties.findIndex((p) => p.id === prop.id);
      if (i >= 0) board.cardProperties[i] = prop;
      else board.cardProperties.push(prop);
    }
    if (Array.isArray(body.deletedCardProperties)) {
      const gone = new Set(body.deletedCardProperties.filter((id): id is string => typeof id === 'string'));
      board.cardProperties = board.cardProperties.filter((p) => !gone.has(p.id));
    }
    board.modifiedBy = user.id;
    board.updateAt = now();
    this.store.putBoard(board);
    this.pushBoard(board);
    return board;
  }

  private join({ params, user }: Ctx): unknown {
    const board = this.store.getBoard(params[0]!);
    if (!board || board.deleteAt) throw notFound('board');
    const existing = this.store.getMember(board.id, user.id);
    if (existing) return existing;
    if (board.isTemplate || board.type !== 'O') throw new ApiError(403, 'This board is private; ask a member to add you.');
    const member: Member = { boardId: board.id, userId: user.id, roles: '', minimumRole: '', schemeAdmin: false, schemeEditor: true, schemeCommenter: false, schemeViewer: false, synthetic: false };
    this.store.putMember(member);
    publish(board.teamId, { action: 'UPDATE_MEMBER', member }, this.canSee(board));
    return member;
  }

  // ---- blocks ------------------------------------------------------------------------------

  /**
   * Stores-ready blocks with server ids. A parentId, cardOrder or contentOrder that names another
   * block of the same request (or a board of it) is rewritten to the new id.
   */
  private newBlocks(inputs: Obj[], boardOf: (b: Obj) => string, user: User, ids: Map<string, string>): Block[] {
    const at = now();
    for (const b of inputs) {
      const type = str(b.type);
      if (!type) throw new ApiError(400, 'Every block needs a type.');
      if (typeof b.id === 'string' && b.id) ids.set(b.id, newId(idKind(type)));
    }
    const remap = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? (ids.get(x) ?? x) : x)) : v);
    return inputs.map((b) => {
      const boardId = boardOf(b);
      const fields = obj(b.fields);
      for (const key of ['cardOrder', 'contentOrder']) if (key in fields) fields[key] = remap(fields[key]);
      const parent = str(b.parentId);
      return {
        id: (typeof b.id === 'string' && ids.get(b.id)) || newId(idKind(str(b.type))),
        parentId: parent ? (ids.get(parent) ?? parent) : boardId,
        createdBy: user.id,
        modifiedBy: user.id,
        schema: 1,
        type: str(b.type),
        title: str(b.title),
        fields,
        createAt: at,
        updateAt: at,
        deleteAt: 0,
        boardId,
      };
    });
  }

  private createBlocks({ req, params, user }: Ctx): unknown {
    const board = this.writableBoard(params[0]!, user);
    const inputs = bodyArray(req).filter(isObj);
    const blocks = this.newBlocks(inputs, () => board.id, user, new Map());
    this.store.transaction(() => {
      for (const block of blocks) this.store.putBlock(block);
    });
    for (const block of blocks) this.pushBlock(board, block);
    return blocks;
  }

  private boardBlock(board: Board, blockId: string): Block {
    const block = this.store.getBlock(blockId);
    if (!block || block.boardId !== board.id) throw notFound('block');
    return block;
  }

  private patchBlock({ req, params, user }: Ctx): unknown {
    const board = this.writableBoard(params[0]!, user);
    const block = this.boardBlock(board, params[1]!);
    const body = bodyObject(req);
    if (typeof body.title === 'string') block.title = body.title;
    if (typeof body.parentId === 'string' && body.parentId) block.parentId = body.parentId;
    const fields = block.fields ?? {};
    if (isObj(body.updatedFields)) Object.assign(fields, structuredClone(body.updatedFields));
    if (Array.isArray(body.deletedFields)) for (const key of body.deletedFields) if (typeof key === 'string') delete fields[key];
    block.fields = fields;
    block.modifiedBy = user.id;
    block.updateAt = now();
    this.store.putBlock(block);
    this.pushBlock(board, block);
    return {};
  }

  /** Deletes a block and everything under it (a card's text, comments and checklists). */
  private deleteBlock({ params, user }: Ctx): unknown {
    const board = this.writableBoard(params[0]!, user);
    const root = this.boardBlock(board, params[1]!);
    const doomed = new Map<string, Block>();
    const walk = (b: Block) => {
      doomed.set(b.id, b);
      for (const child of this.store.childrenOf(b.id)) if (child.boardId === board.id && !doomed.has(child.id)) walk(child);
    };
    walk(root);
    this.store.transaction(() => {
      for (const id of doomed.keys()) this.store.deleteBlock(id);
    });
    const at = now();
    for (const id of doomed.keys()) {
      const tombstone: Block = { id, parentId: '', createdBy: '', modifiedBy: '', schema: 0, type: '', title: '', fields: null, createAt: 0, updateAt: at, deleteAt: at, boardId: board.id };
      this.pushBlock(board, tombstone);
    }
    return {};
  }
}

function notFound(what: string): never {
  throw new ApiError(404, `No such ${what}.`);
}
