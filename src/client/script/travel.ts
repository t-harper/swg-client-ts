/**
 * Travel / shuttle helpers — `ctx.travel` and the matching action methods.
 *
 * Exposes finders for the nearby ticket vendor terminal + ticket collector
 * (the protocol-droid sub-object that sits next to a starport / shuttleport)
 * plus the live list of travel tickets in the player's inventory.
 *
 * Wire flow this module orchestrates (verified against `~/code/swg-main`):
 *
 *   1. The vendor terminal lives at `object/tangible/terminal/
 *      shared_terminal_travel.iff` (script `terminal.terminal_travel`).
 *      `ObjectMenuSelectMessage(terminalId, ITEM_USE=21)` triggers its
 *      `OnObjectMenuSelect`, which calls `enterClientTicketPurchaseMode`
 *      → server pushes `EnterTicketPurchaseModeMessage(planet, point,
 *      instantTravel)` scoped to the terminal's home starport.
 *   2. To populate destinations the client sends one
 *      `PlanetTravelPointListRequest(playerId, planetName)` per planet of
 *      interest; the server replies with `PlanetTravelPointListResponse`
 *      carrying parallel name/position/cost/isInterplanetary arrays.
 *   3. Purchase = `useAbility('purchaseTicket', 0n, "<planet1> <point1>
 *      <planet2> <point2> <roundtrip> <instant>")`. Travel point names
 *      with spaces are encoded as `_` (server applies `underscoreToSpace`
 *      in CommandCppFuncs.cpp:5466). The server-side script debits the
 *      computed cost (route + endpoints) and instantiates a
 *      `travel_ticket` tangible in the player's inventory.
 *   4. Use = walk within boarding range (`isInShuttleBoardingRange`) of a
 *      nearby shuttle pilot/collector, then `useAbility('boardShuttle',
 *      shuttleId, ticketId)`. Server fires `CmdStartScene` for the
 *      destination scene; this module returns from `useTicket` only after
 *      observing that `CmdStartScene`.
 */

import { CmdStartScene } from '../../messages/game/cmd-start-scene.js';
import {
  CommandQueueEnqueue,
  NO_TARGET,
  hashCommand,
  wrapAsObjControllerMessage,
} from '../../messages/game/command-queue/index.js';
import {
  ObjectMenuSelectMessage,
  RadialMenuTypes,
} from '../../messages/game/object-menu-select-message.js';
import {
  EnterTicketPurchaseModeMessage,
  PlanetTravelPointListRequest,
  PlanetTravelPointListResponse,
} from '../../messages/game/travel/index.js';
import type { GameNetworkMessage } from '../../messages/interface.js';
import type { NetworkId, Vector3 } from '../../types.js';
import type { MessageDispatcher } from '../dispatcher.js';
import type { InventoryView } from '../inventory-view.js';
import { normalizePlanetName } from '../location.js';
import type { WorldModel, WorldObject } from '../world-model.js';

/** One travel ticket currently in the player's inventory. */
export interface TravelTicket {
  /** NetworkId of the ticket item (use this with `useTicket`). */
  readonly itemId: NetworkId;
  /**
   * Human-readable best-effort description of the destination. Reads the
   * inventory item's `name` (which on the live server typically renders as
   * "Travel Ticket: <Departure> -> <Arrival>"). May be the empty string
   * until the SHARED baseline arrives.
   */
  readonly destinationDescription: string;
}

/** Options for `TravelView.findTicketVendor` / `findTicketCollector`. */
export interface TravelFinderOptions {
  /** Search radius in metres around the player. Default 64m. */
  maxRadiusM?: number;
}

/**
 * The `ctx.travel` always-on view. Pure-derived state over the
 * `WorldModel` + `InventoryView`; no lifecycle of its own.
 */
export interface TravelView {
  /**
   * Find the nearest ticket vendor terminal (the
   * `object/tangible/terminal/shared_terminal_travel.iff` object the
   * starport sets up next to its shuttle pad). Match is by templateName
   * regex `/(shared_)?terminal_travel(_|\.iff)/`, then sorted by 2D
   * distance to the player. Returns `undefined` if none within the radius.
   */
  findTicketVendor(opts?: TravelFinderOptions): WorldObject | undefined;
  /**
   * Find the nearest ticket collector — the protocol-droid sub-object next
   * to a shuttleport that runs the `item.travel_ticket.travel_shuttle_pilot`
   * script and accepts the `boardShuttle` ability. Match is by templateName
   * regex `/(shared_)?ticket_collector\.iff/`. As a fallback when the
   * collector template hasn't been observed, returns the nearest shuttle
   * (`/(shared_)?lambda_shuttle|player_shuttle|kash_rodian_shuttle/`).
   */
  findTicketCollector(opts?: TravelFinderOptions): WorldObject | undefined;
  /**
   * Live snapshot of every `travel_ticket` item currently in the player's
   * inventory. Returns `[]` until the inventory view has discovered the
   * inventory container.
   */
  currentTickets(): TravelTicket[];
}

/** Options for `buyTicket`. */
export interface BuyTicketOptions {
  /**
   * Vendor NetworkId override. If omitted, calls `findTicketVendor()` and
   * throws if none is in range.
   */
  vendorId?: NetworkId;
  /**
   * Destination travel-point name (lowercase, e.g. `"bestine"`, `"theed"`).
   * Matched case-insensitively against the response's `travelPointNameList`
   * (which may carry mixed-case display strings — the server-side check
   * normalizes both sides via `equals`-on-lowercase).
   *
   * Spaces in display names (e.g. `"Mos Eisley"`) are accepted as-is; this
   * helper applies the `space → underscore` substitution that the
   * `purchaseTicket` command parser expects.
   */
  destination: string;
  /**
   * Destination planet override. Defaults to "find a planet whose listing
   * contains `destination`" — that resolution is the common case (the
   * vendor scope IS the departure planet, the destination's planet is
   * looked up from the destinations response).
   */
  destinationPlanet?: string;
  /**
   * If true, requests a round-trip ticket (server creates two tickets and
   * doubles the cost). Default false.
   */
  roundTrip?: boolean;
  /**
   * Total ms to wait for the `EnterTicketPurchaseModeMessage` + every
   * destination list reply + the ticket-creation observation. Default 15s.
   */
  timeoutMs?: number;
}

/** Options for `useTicket`. */
export interface UseTicketOptions {
  /**
   * Ticket item NetworkId. If omitted, picks the first entry from
   * `currentTickets()`.
   */
  ticketId?: NetworkId;
  /**
   * Collector / shuttle NetworkId. If omitted, calls
   * `findTicketCollector()` and throws if none in range.
   */
  collectorId?: NetworkId;
  /** ms to wait for the inbound `CmdStartScene`. Default 30s. */
  timeoutMs?: number;
}

/** Outcome of `useTicket` — the scene the server warped us to. */
export interface UseTicketResult {
  /** New planet (post-normalization, e.g. `"naboo"`). */
  destinationPlanet: string;
  /** Spawn position in the new scene from `CmdStartScene.startPosition`. */
  destinationPosition: Vector3;
}

/** Options for `listDestinations`. */
export interface ListDestinationsOptions {
  /** Vendor NetworkId override; same fallback as `buyTicket`. */
  vendorId?: NetworkId;
  /** Total ms to wait for the SUI + each destination response. Default 10s. */
  timeoutMs?: number;
}

/** Minimum host surface needed by the travel helpers. */
export interface TravelHostContext {
  readonly dispatcher: MessageDispatcher;
  readonly world: WorldModel;
  readonly inventory: InventoryView;
  readonly signal: AbortSignal;
  readonly sceneStart: { playerNetworkId: NetworkId };
  position(): Readonly<{ x: number; y: number; z: number }>;
  nextCommandSequence(): number;
  send<T extends GameNetworkMessage>(msg: T): void;
}

/**
 * One destination resolved during a `listDestinations` / `buyTicket` call —
 * a flattened (planet, point) pair with metadata. Returned via
 * `buyTicket` only on the error path (so callers can diff their requested
 * destination against the actual set the server reported).
 */
export interface ResolvedDestination {
  planet: string;
  point: string;
  position: Vector3;
  cost: number;
  isInterplanetary: boolean;
}

/** Regex for the ticket-vendor terminal template (server: `terminal_travel.tpf`). */
const VENDOR_TEMPLATE = /(?:shared_)?terminal_travel(?:[_.]|$)/i;
/** Regex for the ticket-collector droid template (server: `ticket_collector.tpf`). */
const COLLECTOR_TEMPLATE = /(?:shared_)?ticket_collector\.iff$/i;
/** Fallback collector match — shuttle creatures themselves accept the boardShuttle command too. */
const SHUTTLE_TEMPLATE = /(?:shared_)?(?:lambda_shuttle|player_shuttle|kash_rodian_shuttle)/i;
/** Template stem of a travel ticket item. */
const TICKET_TEMPLATE = /travel_ticket/i;

/**
 * Known template CRCs of the things we hunt for. The live `swg-server`
 * pushes most objects via `SceneCreateObjectByCrc`, which doesn't carry
 * a templateName — only the standard CRC-32 of the shared template path.
 * Verified via sniffing live `SceneCreateObjectByCrc` events and by
 * re-running the `Crc::calculate` algorithm from
 * `~/code/swg-main/src/engine/shared/library/sharedFoundation/src/shared/Crc.cpp`
 * over the IFF path.
 */
export const TRAVEL_VENDOR_TEMPLATE_CRCS: ReadonlySet<number> = new Set([
  0x7402f0fc, // object/tangible/terminal/shared_terminal_travel.iff
  0x238ecb03, // object/tangible/terminal/shared_terminal_travel_instant.iff
]);
export const TRAVEL_COLLECTOR_TEMPLATE_CRCS: ReadonlySet<number> = new Set([
  0xfcf0b40d, // object/tangible/travel/ticket_collector/shared_ticket_collector.iff
]);
export const TRAVEL_SHUTTLE_TEMPLATE_CRCS: ReadonlySet<number> = new Set([
  0xdfb18b8e, // object/creature/npc/theme_park/shared_lambda_shuttle.iff
  0x764dc035, // object/creature/npc/theme_park/shared_player_shuttle.iff
]);
export const TRAVEL_TICKET_TEMPLATE_CRCS: ReadonlySet<number> = new Set([
  0xdaa0de83, // object/tangible/travel/travel_ticket/base/shared_base_travel_ticket.iff
]);

/** Default search radius for `findTicketVendor` / `findTicketCollector`. */
const DEFAULT_FINDER_RADIUS_M = 64;

/** True if `o`'s templateName matches `re` OR its templateCrc is in `crcs`. */
function templateMatches(o: WorldObject, re: RegExp, crcs: ReadonlySet<number>): boolean {
  const t = o.templateName ?? '';
  if (t !== '' && re.test(t)) return true;
  if (o.templateCrc !== undefined && crcs.has(o.templateCrc)) return true;
  return false;
}

/** Build the `ctx.travel` view. Stateless; reads `world` + `inventory` live. */
export function createTravelView(host: TravelHostContext): TravelView {
  function findNearestMatching(
    re: RegExp,
    crcs: ReadonlySet<number>,
    maxRadiusM: number,
    fallback?: { re: RegExp; crcs: ReadonlySet<number> },
  ): WorldObject | undefined {
    const here = host.position();
    const maxR2 = maxRadiusM * maxRadiusM;
    let bestPrimary: WorldObject | undefined;
    let bestPrimaryD2 = Number.POSITIVE_INFINITY;
    let bestFallback: WorldObject | undefined;
    let bestFallbackD2 = Number.POSITIVE_INFINITY;
    for (const o of host.world.objects()) {
      const dx = o.position.x - here.x;
      const dz = o.position.z - here.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > maxR2) continue;
      if (templateMatches(o, re, crcs)) {
        if (d2 < bestPrimaryD2) {
          bestPrimary = o;
          bestPrimaryD2 = d2;
        }
      } else if (fallback !== undefined && templateMatches(o, fallback.re, fallback.crcs)) {
        if (d2 < bestFallbackD2) {
          bestFallback = o;
          bestFallbackD2 = d2;
        }
      }
    }
    return bestPrimary ?? bestFallback;
  }
  return {
    findTicketVendor(opts) {
      return findNearestMatching(
        VENDOR_TEMPLATE,
        TRAVEL_VENDOR_TEMPLATE_CRCS,
        opts?.maxRadiusM ?? DEFAULT_FINDER_RADIUS_M,
      );
    },
    findTicketCollector(opts) {
      return findNearestMatching(
        COLLECTOR_TEMPLATE,
        TRAVEL_COLLECTOR_TEMPLATE_CRCS,
        opts?.maxRadiusM ?? DEFAULT_FINDER_RADIUS_M,
        { re: SHUTTLE_TEMPLATE, crcs: TRAVEL_SHUTTLE_TEMPLATE_CRCS },
      );
    },
    currentTickets(): TravelTicket[] {
      const out: TravelTicket[] = [];
      const seen = new Set<NetworkId>();
      // First pass: walk the typed InventoryView, which knows `templateName`
      // and the SHARED-baseline-derived `name`.
      for (const it of host.inventory.items) {
        const t = it.templateName ?? '';
        if (TICKET_TEMPLATE.test(t)) {
          out.push({ itemId: it.networkId, destinationDescription: it.name ?? '' });
          seen.add(it.networkId);
        }
      }
      // Second pass: the live `swg-server` often pushes items via
      // `SceneCreateObjectByCrc` — `InventoryView.items` has them but with
      // `templateName === null`. Walk the WorldModel directly so we can
      // also match on `templateCrc`.
      const invId = host.inventory.containerId;
      if (invId !== null) {
        for (const o of host.world.objects()) {
          if (o.containerId !== invId) continue;
          if (seen.has(o.id)) continue;
          if (o.templateCrc !== undefined && TRAVEL_TICKET_TEMPLATE_CRCS.has(o.templateCrc)) {
            out.push({ itemId: o.id, destinationDescription: '' });
            seen.add(o.id);
          }
        }
      }
      return out;
    },
  };
}

/**
 * Send `ObjectMenuSelectMessage(terminalId, ITEM_USE)` and wait for the
 * server's `EnterTicketPurchaseModeMessage`. Returns the (departure planet,
 * departure point) the terminal reported. Throws on timeout.
 */
async function openTicketVendor(
  host: TravelHostContext,
  vendorId: NetworkId,
  timeoutMs: number,
): Promise<{ planet: string; point: string; instantTravel: boolean }> {
  const wait = host.dispatcher.waitFor(EnterTicketPurchaseModeMessage, { timeoutMs });
  host.send(new ObjectMenuSelectMessage(vendorId, RadialMenuTypes.ITEM_USE));
  const reply = await wait;
  return {
    planet: reply.planetName,
    point: reply.travelPointName,
    instantTravel: reply.instantTravel,
  };
}

/**
 * Send a `PlanetTravelPointListRequest(player, planet)` and wait for the
 * matching `PlanetTravelPointListResponse`. Matches by `planetName` since
 * the wire response is not sequenced.
 */
async function requestPlanetDestinations(
  host: TravelHostContext,
  planet: string,
  timeoutMs: number,
): Promise<PlanetTravelPointListResponse> {
  const wait = host.dispatcher.waitFor(PlanetTravelPointListResponse, {
    timeoutMs,
    predicate: (m) => m.planetName === planet,
  });
  host.send(new PlanetTravelPointListRequest(host.sceneStart.playerNetworkId, planet));
  return wait;
}

/**
 * Query the vendor for the union of all reachable (planet, point) pairs.
 * Probes the vendor's home planet plus the standard SWG planet roster.
 * Returns a flattened `ResolvedDestination[]` (cost includes the per-point
 * cost only — full ticket cost is `route + departCost + arriveCost`).
 */
async function fetchAllDestinations(
  host: TravelHostContext,
  vendorId: NetworkId,
  timeoutMs: number,
): Promise<{
  departurePlanet: string;
  departurePoint: string;
  destinations: ResolvedDestination[];
}> {
  const vendor = await openTicketVendor(host, vendorId, timeoutMs);
  // Standard planet list (matches the columns in dsrc travel.tab). We ask
  // for each — server-side `getPlanetTravelPointInterplanetary` filters
  // out unreachable routes via the cost-zero check downstream when the
  // player tries to purchase. The destination list itself is per-planet.
  const planets = [
    'corellia',
    'dantooine',
    'dathomir',
    'endor',
    'lok',
    'naboo',
    'rori',
    'talus',
    'tatooine',
    'yavin4',
    'mustafar',
    'kashyyyk_main',
  ];
  // Always include the vendor's home planet first.
  if (!planets.includes(vendor.planet)) planets.unshift(vendor.planet);
  const destinations: ResolvedDestination[] = [];
  for (const planet of planets) {
    let resp: PlanetTravelPointListResponse;
    try {
      resp = await requestPlanetDestinations(
        host,
        planet,
        Math.max(2_000, timeoutMs / planets.length),
      );
    } catch {
      // The server only sends a response when the planet object exists in
      // ServerUniverse. Unknown planets (e.g. expansion not loaded) get
      // a DEBUG_WARNING in Client.cpp and no reply. Treat as empty.
      continue;
    }
    for (let i = 0; i < resp.travelPointNameList.length; i++) {
      const name = resp.travelPointNameList[i];
      const pos = resp.travelPointPointList[i];
      const cost = resp.travelPointCostList[i] ?? 0;
      const inter = resp.travelPointInterplanetaryList[i] ?? false;
      if (name === undefined || pos === undefined) continue;
      destinations.push({
        planet: resp.planetName,
        point: name,
        position: pos,
        cost,
        isInterplanetary: inter,
      });
    }
  }
  return {
    departurePlanet: vendor.planet,
    departurePoint: vendor.point,
    destinations,
  };
}

/**
 * Encode a travel-point name for the `purchaseTicket` command params. The
 * server applies `underscoreToSpace`, so we replace spaces with underscores
 * before sending. Leaves the casing intact.
 */
export function encodeTravelPointForCommand(name: string): string {
  return name.replace(/ /g, '_');
}

/**
 * Send the `purchaseTicket` command via the command queue. Returns the
 * sequence id (callers can correlate with a CommandQueueRemove if needed).
 */
function sendPurchaseTicketCommand(
  host: TravelHostContext,
  departurePlanet: string,
  departurePoint: string,
  arrivalPlanet: string,
  arrivalPoint: string,
  roundTrip: boolean,
  instantTravel: boolean,
): number {
  const seq = host.nextCommandSequence();
  const params = [
    departurePlanet,
    encodeTravelPointForCommand(departurePoint),
    arrivalPlanet,
    encodeTravelPointForCommand(arrivalPoint),
    roundTrip ? 1 : 0,
    instantTravel ? 1 : 0,
  ].join(' ');
  const enqueue = new CommandQueueEnqueue(seq, hashCommand('purchaseTicket'), NO_TARGET, params);
  host.send(wrapAsObjControllerMessage(enqueue, host.sceneStart.playerNetworkId));
  return seq;
}

/**
 * Implementation of `ctx.buyTicket()`. Returns the NetworkId of the
 * newly-created ticket. Throws on timeout, missing vendor, no-such-
 * destination, server refusal (no money / banned / etc.).
 */
export async function buyTicket(
  host: TravelHostContext,
  view: TravelView,
  opts: BuyTicketOptions,
): Promise<NetworkId> {
  if (opts.destination === '') {
    throw new Error('travel.buyTicket: destination must be non-empty');
  }
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const vendorObj =
    opts.vendorId === undefined ? view.findTicketVendor() : host.world.get(opts.vendorId);
  if (vendorObj === undefined) {
    throw new Error(
      `travel.buyTicket: no ticket vendor in range${opts.vendorId !== undefined ? ` (id=0x${opts.vendorId.toString(16)} not in WorldModel)` : ''}`,
    );
  }
  const vendorId = vendorObj.id;

  const all = await fetchAllDestinations(host, vendorId, timeoutMs);
  if (all.destinations.length === 0) {
    throw new Error('travel.buyTicket: vendor returned no destinations');
  }
  const wantedPoint = opts.destination.toLowerCase();
  const wantedPlanet = opts.destinationPlanet?.toLowerCase();
  const match = all.destinations.find((d) => {
    if (wantedPlanet !== undefined && d.planet.toLowerCase() !== wantedPlanet) return false;
    return d.point.toLowerCase() === wantedPoint;
  });
  if (match === undefined) {
    const avail = all.destinations.map((d) => `${d.planet}/${d.point}`).join(', ');
    throw new Error(
      `travel.buyTicket: destination ${opts.destinationPlanet ?? '*'}/${opts.destination} not in vendor list. Available: ${avail}`,
    );
  }

  // Watch the inventory for a newly-created travel ticket. We snapshot the
  // pre-purchase ids so we can identify the new one when the BaselinesMessage
  // arrives. The server creates the ticket via `createObject` and the client
  // sees SceneCreate + Containment(player.inventory) + Baseline.
  const before = new Set(view.currentTickets().map((t) => t.itemId));
  const deadline = Date.now() + timeoutMs;

  sendPurchaseTicketCommand(
    host,
    all.departurePlanet,
    all.departurePoint,
    match.planet,
    match.point,
    opts.roundTrip ?? false,
    false, // purchaseTicket is the regular (non-instant) path; instantTravel
    // is a separate command on the wire (`commandFuncPurchaseTicketInstantTravel`)
    // that this helper doesn't expose. The server's
    // EnterTicketPurchaseModeMessage.instantTravel field tells us the vendor's
    // capability — instant travel maps to the `instantTicket` command path
    // (out of scope for the initial helper).
  );

  while (Date.now() < deadline) {
    if (host.signal.aborted) throw new Error('travel.buyTicket: aborted');
    const now = view.currentTickets();
    for (const t of now) {
      if (!before.has(t.itemId)) return t.itemId;
    }
    await sleep(250, host.signal);
  }
  throw new Error(
    `travel.buyTicket: server did not create a ticket within ${timeoutMs}ms (vendor=0x${vendorId.toString(16)}, dest=${match.planet}/${match.point})`,
  );
}

/**
 * Implementation of `ctx.listDestinations()`. Returns one
 * `"<planet>/<point>"` entry per (planet, point) tuple the vendor reports
 * across every known planet.
 */
export async function listDestinations(
  host: TravelHostContext,
  view: TravelView,
  opts?: ListDestinationsOptions,
): Promise<string[]> {
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  const vendorObj =
    opts?.vendorId === undefined ? view.findTicketVendor() : host.world.get(opts.vendorId);
  if (vendorObj === undefined) {
    throw new Error(
      `travel.listDestinations: no ticket vendor in range${opts?.vendorId !== undefined ? ` (id=0x${opts.vendorId.toString(16)} not in WorldModel)` : ''}`,
    );
  }
  const all = await fetchAllDestinations(host, vendorObj.id, timeoutMs);
  return all.destinations.map((d) => `${d.planet}/${d.point}`);
}

/**
 * Implementation of `ctx.useTicket()`. Sends `useAbility('boardShuttle',
 * collectorId, ticketId)` and waits for the inbound `CmdStartScene` that
 * marks the actual scene transition. Returns the new (planet, position).
 */
export async function useTicket(
  host: TravelHostContext,
  view: TravelView,
  opts?: UseTicketOptions,
): Promise<UseTicketResult> {
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  let ticketId = opts?.ticketId;
  if (ticketId === undefined) {
    const tickets = view.currentTickets();
    if (tickets.length === 0) {
      throw new Error('travel.useTicket: no ticket in inventory');
    }
    const first = tickets[0];
    if (first === undefined) {
      throw new Error('travel.useTicket: no ticket in inventory');
    }
    ticketId = first.itemId;
  }

  let collectorId = opts?.collectorId;
  if (collectorId === undefined) {
    const collector = view.findTicketCollector();
    if (collector === undefined) {
      throw new Error('travel.useTicket: no ticket collector / shuttle in range');
    }
    collectorId = collector.id;
  }

  const wait = host.dispatcher.waitFor(CmdStartScene, { timeoutMs });
  const seq = host.nextCommandSequence();
  const enqueue = new CommandQueueEnqueue(
    seq,
    hashCommand('boardShuttle'),
    collectorId,
    ticketId.toString(),
  );
  host.send(wrapAsObjControllerMessage(enqueue, host.sceneStart.playerNetworkId));

  const start = await wait;
  return {
    destinationPlanet: normalizePlanetName(start.sceneName),
    destinationPosition: start.startPosition,
  };
}

/** Helper — abortable sleep used by the purchase-watch loop. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    t.unref?.();
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
