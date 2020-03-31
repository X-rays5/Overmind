import {assimilationLocked} from '../assimilation/decorator';
import {Colony} from '../Colony';
import {log} from '../console/log';
import {Mem} from '../memory/Memory';
import {profile} from '../profiler/decorator';
import {Abathur} from '../resources/Abathur';
import {
	BASE_RESOURCES,
	BOOSTS_T1,
	BOOSTS_T2,
	BOOSTS_T3,
	INTERMEDIATE_REACTANTS,
	RESOURCES_ALL_EXCEPT_ENERGY
} from '../resources/map_resources';
import {alignedNewline, bullet, rightArrow} from '../utilities/stringConstants';
import {exponentialMovingAverage, maxBy, mergeSum, minBy, printRoomName} from '../utilities/utils';
import {TraderJoe} from './TradeNetwork';

interface TerminalNetworkStats {
	transfers: {
		[resourceType: string]: {
			[origin: string]: {
				[destination: string]: number
			}
		},
		costs: {
			[origin: string]: {
				[destination: string]: number
			}
		}
	};
	terminals: {
		avgCooldown: { // moving exponential average of cooldown - ranges from 0 to 5
			[colonyName: string]: number
		};
		overload: { // moving exponential average of (1 if terminal wants to send but can't | 0 otherwise)
			[colonyName: string]: number
		};
	};
	states: {
		// These are grouped as (stateTier: { colonyName: { resources[] } } )
		activeProviders: { [colony: string]: string[] };
		passiveProviders: { [colony: string]: string[] };
		equilibriumNodes: { [colony: string]: string[] };
		passiveRequestors: { [colony: string]: string[] };
		activeRequestors: { [colony: string]: string[] };
	};
}

const TerminalNetworkStatsDefaults: TerminalNetworkStats = {
	transfers: {
		costs: {},
	},
	terminals: {
		avgCooldown: {},
		overload   : {},
	},
	states   : {
		activeProviders  : {},
		passiveProviders : {},
		equilibriumNodes : {},
		passiveRequestors: {},
		activeRequestors : {},
	}
};

export const enum TN_STATE {
	activeProvider   = 5, // actively offload the resource into other non-activeProvider rooms in the network
	passiveProvider  = 4, // place their resource at the disposal of the network
	equilibrium      = 3, // close to the desired amount of resource and prefer not to trade except to activeRequestors
	passiveRequestor = 2, // below target amount of resource and will receive from providers
	activeRequestor  = 1, // have an immediate need of the resource and will be filled by other non-activeRequestors
	error            = 0, // this should never be used
}

interface RequestOpts {
	allowDivvying?: boolean;
	sendTargetPlusTolerance?: boolean;
	allowMarketBuy?: boolean;
	receiveOnlyOncePerTick?: boolean;
}

interface ProvideOpts {
	allowPushToOtherRooms?: boolean;
	allowMarketSell?: boolean;
}

const DEFAULT_TARGET = 2 * LAB_MINERAL_CAPACITY + 1000; // 7000 is default for most resources
const DEFAULT_SURPLUS = 15 * LAB_MINERAL_CAPACITY;		// 45000 is default surplus
const DEFAULT_TOLERANCE = LAB_MINERAL_CAPACITY / 3;		// 1000 is default tolerance

const THRESHOLDS_DEFAULT: Thresholds = { // default thresholds for most resources
	target   : DEFAULT_TARGET,
	surplus  : DEFAULT_SURPLUS,
	tolerance: DEFAULT_TOLERANCE,
};
const THRESHOLDS_DONT_WANT: Thresholds = { // thresholds for stuff you actively don't want
	target   : 0,
	surplus  : 0, // surplus = 0 means colony will always be at activeProvider if it has any, else
	tolerance: 0,
};
const THRESHOLDS_DONT_CARE: Thresholds = { // thresholds for stuff you don't need but don't not want
	target   : 0,
	surplus  : undefined,
	tolerance: 0,
};
const THRESHOLDS_POWER: Thresholds = { // low target ensures power gets spread among room (cheaper than shipping energy)
	target   : 2500, // should be equal to tolerance
	surplus  : undefined,
	tolerance: 2500, // should be equal to target to prevent active buying
};
const THRESHOLDS_OPS: Thresholds = { // might need to come back to this when I actually do power creeps
	target   : 2500, // should be equal to tolerance
	surplus  : undefined,
	tolerance: 2500, // should be equal to target to prevent active buying
};

function getThresholds(resource: _ResourceConstantSansEnergy): Thresholds {
	/*// Energy gets special treatment - see TradeNetwork.getEnergyThresholds()
	if (resource == RESOURCE_ENERGY) {
		return THRESHOLDS_DONT_CARE;
	}*/
	// Power and ops get their own treatment
	if (resource == RESOURCE_POWER) {
		return THRESHOLDS_POWER;
	}
	if (resource == RESOURCE_OPS) {
		return THRESHOLDS_OPS;
	}
	// All mineral compounds below
	if (Abathur.isBaseMineral(resource)) { // base minerals get default treatment
		return THRESHOLDS_DEFAULT;
	}
	if (Abathur.isIntermediateReactant(resource)) { // reaction intermediates (plus ghodium) get default
		return THRESHOLDS_DEFAULT;
	}
	if (Abathur.isHealBoost(resource)) { // heal boosts are really important and commonly used
		return {
			target   : 1.5 * DEFAULT_TARGET,
			surplus  : DEFAULT_SURPLUS,
			tolerance: DEFAULT_TOLERANCE,
		};
	}
	// if (Abathur.isCarryBoost(resource) || Abathur.isHarvestBoost(resource)) { // I don't use these
	// 	return THRESHOLDS_DONT_WANT;
	// }
	if (Abathur.isMineralOrCompound(resource)) { // all other boosts and resources are default
		return THRESHOLDS_DEFAULT;
	}
	// Base deposit resources
	if (Abathur.isDepositResource(resource)) {
		return THRESHOLDS_DONT_CARE;
	}
	// Everything else should be a commodity
	if (Abathur.isCommodity(resource)) {
		return THRESHOLDS_DONT_CARE;
	}
	// Shouldn't reach here since I've handled everything above
	log.error(`Shouldn't reach here! Unhandled resource ${resource} in getThresholds()!`);
	return THRESHOLDS_DONT_CARE;
}

// Contains threshold values to use for all non-execeptional colonies so we don't recompute this every time
const ALL_THRESHOLDS: { [resourceType: string]: Thresholds } =
		  _.object(RESOURCES_ALL_EXCEPT_ENERGY, _.map(RESOURCES_ALL_EXCEPT_ENERGY, res => getThresholds(res)));

// The order in which resources are handled within the network
const _resourcePrioritiesOrdered = [
	...BOOSTS_T3,
	RESOURCE_OPS,
	...BOOSTS_T2,
	...BOOSTS_T1,
	...INTERMEDIATE_REACTANTS,
	...BASE_RESOURCES,
	RESOURCE_POWER,
	RESOURCE_ENERGY
];
const _resourcePrioritiesEverythingElse = _.filter(RESOURCES_ALL, res => !_resourcePrioritiesOrdered.includes(res));

export const RESOURCE_EXCHANGE_ORDER: ResourceConstant[] = [..._resourcePrioritiesOrdered,
															..._resourcePrioritiesEverythingElse];

const _resourceExchangePrioritiesLookup: { [resource: string]: number } =
		  _.zipObject(RESOURCE_EXCHANGE_ORDER,
					  _.map(RESOURCE_EXCHANGE_ORDER, res => _.indexOf(RESOURCE_EXCHANGE_ORDER, res)));

const EMPTY_COLONY_TIER: { [resourceType: string]: Colony[] } =
		  _.zipObject(RESOURCES_ALL, _.map(RESOURCES_ALL, i => []));


/**
 * The terminal network controls inter-colony resource transfers and requests, equalizing resources between rooms and
 * responding to on-demand resource requests
 */
@profile
@assimilationLocked
export class TerminalNetworkV2 implements ITerminalNetwork {

	private colonies: Colony[];
	private colonyThresholds: { [colName: string]: { [resourceType: string]: Thresholds } };
	private _energyThresholds: Thresholds | undefined;

	private colonyStates: { [colName: string]: { [resourceType: string]: TN_STATE } };
	private activeProviders: { [resourceType: string]: Colony[] };
	private passiveProviders: { [resourceType: string]: Colony[] };
	private equilibriumNodes: { [resourceType: string]: Colony[] };
	private passiveRequestors: { [resourceType: string]: Colony[] };
	private activeRequestors: { [resourceType: string]: Colony[] };

	private assets: { [resourceType: string]: number };
	private notifications: string[];

	private stats: TerminalNetworkStats;
	private terminalOverload: { [colName: string]: boolean };

	static settings = {
		maxEnergySendAmount            : 25000,	// max size you can send of energy in one tick
		maxResourceSendAmount          : 3000,	// max size of resources you can send in one tick
		minColonySpace                 : 20000,	// colonies should have at least this much space in the room
		terminalCooldownAveragingWindow: 1000,	// duration for computing rolling average of terminal cooldowns
	};

	constructor() {
		this.colonies = [];
		this.refresh();
	}

	/**
	 * Clears all the threshold and request data from the previous tick
	 */
	refresh(): void {
		this.colonyThresholds = {};
		this._energyThresholds = undefined;
		this.colonyStates = {};

		this.activeProviders = {}; // _.clone(EMPTY_COLONY_TIER);
		this.passiveProviders = {}; // _.clone(EMPTY_COLONY_TIER);
		this.equilibriumNodes = {}; // _.clone(EMPTY_COLONY_TIER);
		this.passiveRequestors = {}; // _.clone(EMPTY_COLONY_TIER);
		this.activeRequestors = {}; // _.clone(EMPTY_COLONY_TIER);

		this.assets = {}; // populated when getAssets() is called in init()

		this.terminalOverload = {};
		this.notifications = [];
		this.stats = Mem.wrap(Memory.stats.persistent, 'terminalNetwork', TerminalNetworkStatsDefaults, true);
	}

	/**
	 * Adds a colony to the terminal network; should be populated following constructor() phase
	 */
	addColony(colony: Colony): void {
		if (!(colony.terminal && colony.terminal.my && colony.level >= 6)) {
			log.error(`Cannot add colony ${colony.print} to terminal network!`);
		} else {
			this.colonies.push(colony); // add colony to list
		}
	}

	getAssets(): { [resourceType: string]: number } {
		if (_.isEmpty(this.assets)) {
			this.assets = mergeSum(_.map(this.colonies, colony => colony.assets));
		}
		return this.assets;
	}

	// Transfer logging and notification stuff =========================================================================

	private logTransfer(resourceType: ResourceConstant, amount: number, origin: string, destination: string) {
		if (!this.stats.transfers[resourceType]) this.stats.transfers[resourceType] = {};
		if (!this.stats.transfers[resourceType][origin]) this.stats.transfers[resourceType][origin] = {};
		if (!this.stats.transfers[resourceType][origin][destination]) {
			this.stats.transfers[resourceType][origin][destination] = 0;
		}
		this.stats.transfers[resourceType][origin][destination] += amount;
		this.logTransferCosts(amount, origin, destination);
	}

	private logTransferCosts(amount: number, origin: string, destination: string) {
		if (!this.stats.transfers.costs[origin]) this.stats.transfers.costs[origin] = {};
		if (!this.stats.transfers.costs[origin][destination]) this.stats.transfers.costs[origin][destination] = 0;
		const transactionCost = Game.market.calcTransactionCost(amount, origin, destination);
		this.stats.transfers.costs[origin][destination] += transactionCost;
	}

	private notify(msg: string): void {
		this.notifications.push(bullet + msg);
	}

	/**
	 * Transfer resources from one terminal to another, logging the results
	 */
	private transfer(sender: StructureTerminal, receiver: StructureTerminal, resourceType: ResourceConstant,
					 amount: number, description: string): ScreepsReturnCode {
		const cost = Game.market.calcTransactionCost(amount, sender.room.name, receiver.room.name);
		const response = sender.send(resourceType, amount, receiver.room.name);
		if (response == OK) {
			let msg = `${printRoomName(sender.room.name, true)} ${rightArrow} ${amount} ${resourceType} ${rightArrow} ` +
					  `${printRoomName(receiver.room.name, true)} `;
			if (description) {
				msg += `(${description})`;
			}
			this.notify(msg);
			this.logTransfer(resourceType, amount, sender.room.name, receiver.room.name);
		} else {
			log.warning(`Could not send ${amount} ${resourceType} from ${sender.room.print} to ` +
						`${receiver.room.print}! Response: ${response}`);
			if (response == ERR_NOT_ENOUGH_RESOURCES || response == ERR_TIRED) {
				this.terminalOverload[sender.room.name] = true;
			}
		}
		return response;
	}

	/**
	 * Returns the remaining amount of capacity in a colony. Overfilled storages (from OPERATE_STORAGE) are
	 * counted as just being at 100% capacity. Optionally takes an additionalAssets argument that asks whether the
	 * colony would be near capacity if additionalAssets amount of resources were added.
	 */
	private getRemainingSpace(colony: Colony, includeFactoryCapacity = false): number {
		let totalAssets = _.sum(colony.assets);
		// Overfilled storage gets counted as just 100% full
		if (colony.storage && _.sum(colony.storage.store) > STORAGE_CAPACITY) {
			totalAssets -= (_.sum(colony.storage.store) - STORAGE_CAPACITY);
		}

		const roomCapacity = (colony.terminal ? TERMINAL_CAPACITY : 0) +
							 (colony.storage ? STORAGE_CAPACITY : 0) +
							 (colony.factory && includeFactoryCapacity ? FACTORY_CAPACITY : 0);

		return roomCapacity - totalAssets;
	}

	/**
	 * Computes the dynamically-changing energy thresholds object
	 */
	private getEnergyThresholds(): Thresholds {
		if (!this._energyThresholds) {
			const nonExceptionalColonies = _.filter(this.colonies, colony =>
				colony.storage
				&& !(this.colonyThresholds[colony.name] && this.colonyThresholds[colony.name][RESOURCE_ENERGY]));
			const avgEnergy = _.sum(nonExceptionalColonies, colony => colony.assets.energy) /
							  nonExceptionalColonies.length;
			this._energyThresholds = {
				target   : avgEnergy,
				surplus  : 500000,
				tolerance: avgEnergy / 5,
			};
		}
		return this._energyThresholds;
	}

	/**
	 * Compute the default state of a colony for a given resource
	 */
	private getColonyState(colony: Colony, resource: ResourceConstant): TN_STATE {
		const {target, surplus, tolerance} = this.thresholds(colony, resource);
		const amount = colony.assets[resource];

		// Active provider if the room is above surplus amount or if the room is above target+tolerance and near full
		if ((surplus != undefined && amount > surplus)
			|| (amount > target + tolerance
				&& this.getRemainingSpace(colony) < TerminalNetworkV2.settings.minColonySpace)) {
			return TN_STATE.activeProvider;
		}
		// Passive provider if the room has below surplus but above target+tolerance
		if ((surplus != undefined ? surplus : Infinity) >= amount && amount > target + tolerance) {
			return TN_STATE.passiveProvider;
		}
		// Equilibrium state if room has within +/- tolerance of target amount
		if (target + tolerance >= amount && amount >= Math.max(target - tolerance, 0)) {
			return TN_STATE.equilibrium;
		}
		// Passive requestor if room has below target-tolerance
		if (amount < Math.max(target - tolerance, 0)) {
			return TN_STATE.passiveRequestor;
		}
		// Active requestor if room has below target amount and there is an immediate need for the resource
		// This can only be triggered with an override from another part of the program

		// Should never reach here
		log.error(`Shouldn't reach this part of TerminalNetwork code!`);
		return TN_STATE.error;
	}

	/**
	 * Gets the thresholds for a given resource for a specific colony
	 */
	thresholds(colony: Colony, resource: ResourceConstant): Thresholds {
		if (this.colonyThresholds[colony.name] && this.colonyThresholds[colony.name][resource]) {
			return this.colonyThresholds[colony.name][resource];
		} else {
			if (resource == RESOURCE_ENERGY) {
				return this.getEnergyThresholds();
			} else {
				return ALL_THRESHOLDS[resource];
			}
		}
	}

	/**
	 * Request resources from the terminal network, placing the colony in an activeRequestor state
	 */
	requestResource(requestor: Colony, resource: ResourceConstant, amount: number, tolerance = 0): void {
		// If you already have enough resources, you shouldn't have made the request so throw an error message
		if (requestor.assets[resource] >= amount) {
			log.error(`TerminalNetwork.requestResource() called for ${requestor.print} requesting ${amount} of ` +
					  `${resource}, but colony already has ${requestor.assets[resource]} amount!`);
			return;
		}
		if (!this.colonyThresholds[requestor.name]) {
			this.colonyThresholds[requestor.name] = {};
		}
		// If you already requested the resource via a different method, throw a warning and override
		if (this.colonyThresholds[requestor.name][resource] != undefined) {
			log.warning(`TerminalNetwork.colonyThresholds[${requestor.name}][${resource}] already set to:` +
						`${this.colonyThresholds[requestor.name][resource]} Overriding previous request!`);
		}
		// Set the thresholds and set state to activeRequestor
		this.colonyThresholds[requestor.name][resource] = {
			target   : amount,
			surplus  : undefined,
			tolerance: tolerance,
		};
		this.colonyStates[requestor.name][resource] = TN_STATE.activeRequestor;
	}

	/**
	 * Requests that the colony export (and not import) a resource, offloading it through the terminal network or
	 * selling it on the market. If thresholds is specified, the room will actively export thresholds.surplus amount of
	 * resource and will maintain target +/- tolerance amount in the room (so in/out, not necessarily a strict export)
	 */
	exportResource(provider: Colony, resource: ResourceConstant, thresholds: Thresholds = THRESHOLDS_DONT_WANT): void {
		// If you already requested the resource via a different method, throw a warning and override
		if (this.colonyThresholds[provider.name] && this.colonyThresholds[provider.name][resource] != undefined) {
			log.warning(`TerminalNetwork.colonyThresholds[${provider.name}][${resource}] already set to:` +
						`${this.colonyThresholds[provider.name][resource]} Overriding previous request!`);
		}
		// Set the thresholds, but in this case we don't set the state to activeProvider - this is automatically done
		if (!this.colonyThresholds[provider.name]) {
			this.colonyThresholds[provider.name] = {};
		}
		this.colonyThresholds[provider.name][resource] = thresholds;
	}

	// canObtainResource(requestor: Colony, resource: ResourceConstant, amount: number): boolean {
	//
	// }


	init(): void {
		// Update assets
		this.assets = this.getAssets();
		// Clear out the colony states so they can be refreshed during Colony.init(), which is called after this
		for (const colony of this.colonies) {
			this.colonyStates[colony.name] = {};
		}
	}

	/**
	 * Compute which colonies should act as active providers, passive providers, and requestors
	 */
	private assignColonyStates(): void {
		// Assign a state to each colony whose state isn't already specified
		for (const colony of this.colonies) {
			for (const resource of RESOURCE_EXCHANGE_ORDER) {
				if (!this.colonyThresholds[colony.name]) {
					this.colonyThresholds[colony.name] = {};
				}
				if (!this.colonyStates[colony.name][resource]) {
					this.colonyStates[colony.name][resource] = this.getColonyState(colony, resource);
				}
				// Populate the entry in the tier lists
				switch (this.colonyStates[colony.name][resource]) {
					case TN_STATE.activeProvider:
						if (this.activeProviders[resource] == undefined) this.activeProviders[resource] = [];
						this.activeProviders[resource].push(colony);
						break;
					case TN_STATE.passiveProvider:
						if (this.passiveProviders[resource] == undefined) this.passiveProviders[resource] = [];
						this.passiveProviders[resource].push(colony);
						break;
					case TN_STATE.equilibrium:
						if (this.equilibriumNodes[resource] == undefined) this.equilibriumNodes[resource] = [];
						this.equilibriumNodes[resource].push(colony);
						break;
					case TN_STATE.passiveRequestor:
						if (this.passiveRequestors[resource] == undefined) this.passiveRequestors[resource] = [];
						this.passiveRequestors[resource].push(colony);
						break;
					case TN_STATE.activeRequestor:
						if (this.activeRequestors[resource] == undefined) this.activeRequestors[resource] = [];
						this.activeRequestors[resource].push(colony);
						break;
					case TN_STATE.error:
						log.error(`TN_STATE.error type encountered!`);
						break;
					default:
						log.error(`Should not be here! colony state is ${this.colonyStates[colony.name][resource]}`);
						break;
				}
			}
		}
		// Shuffle all the colony orders in each tier - this helps prevent jams
		_.forEach(this.activeRequestors, (cols, resource) => this.activeRequestors[resource!] = _.shuffle(cols));
		_.forEach(this.passiveRequestors, (cols, resource) => this.passiveRequestors[resource!] = _.shuffle(cols));
		_.forEach(this.equilibriumNodes, (cols, resource) => this.equilibriumNodes[resource!] = _.shuffle(cols));
		_.forEach(this.passiveProviders, (cols, resource) => this.passiveProviders[resource!] = _.shuffle(cols));
		_.forEach(this.activeProviders, (cols, resource) => this.activeProviders[resource!] = _.shuffle(cols));
	}

	/**
	 * Gets the best partner colony to send requested resources from based on a heuristic that minimizes transaction
	 * cost while accounting for:
	 * 1. If a terminal has a high output load (often on cooldown), receivers will de-prioritize it (avgCooldown term)
	 * 2. If a terminal is far away, receivers will wait longer to find a less expensive sender (K term)
	 * 3. Bigger transactions with higher costs will wait longer for a closer colony, while smaller transactions
	 *    are less picky (BIG_COST term)
	 */
	private getBestSenderColony(resource: ResourceConstant, amount: number,
								colony: Colony, partners: Colony[]): Colony {
		if (partners.length == 0) {
			log.error(`Passed an empty list of sender partners!`);
		}
		const K = 2; // these constants might need tuning
		const BIG_COST = 2000; // size of a typical large transaction cost
		return maxBy(partners, partner => {
			const sendCost = Game.market.calcTransactionCost(amount, partner.name, colony.name);
			const avgCooldown = this.stats.terminals.avgCooldown[partner.name] || 0;
			const score = -1 * (sendCost) * (K + sendCost / BIG_COST + avgCooldown);
			return score;
		}) as Colony;
	}

	/**
	 * Handle a request instance, trying to obtain the desired resource
	 */
	private handleRequestInstance(colony: Colony, resource: ResourceConstant, requestAmount: number,
								  partnerSets: Colony[][], opts: RequestOpts): boolean {
		// Try to find the best single colony to obtain resources from
		for (const partners of partnerSets) {
			// First try to find a partner that has more resources than (target + request)
			let validPartners: Colony[] = _.filter(partners, partner =>
				partner.assets[resource] - requestAmount >= this.thresholds(partner, resource).target);
			// If that doesn't work, try to find a partner where assets - request > target - tolerance
			if (validPartners.length == 0) {
				validPartners = _.filter(partners, partner =>
					partner.assets[resource] - requestAmount >=
					this.thresholds(partner, resource).target - this.thresholds(colony, resource).tolerance);
			}
			if (validPartners.length > 0) {
				const bestPartner = this.getBestSenderColony(resource, requestAmount, colony, validPartners);
				const sendTerm = bestPartner.terminal!;
				const recvTerm = colony.terminal!;
				const maxAmount = resource == RESOURCE_ENERGY ? TerminalNetworkV2.settings.maxEnergySendAmount
															  : TerminalNetworkV2.settings.maxResourceSendAmount;
				const sendAmount = Math.min(requestAmount, sendTerm.store[resource], maxAmount);
				// Send the resources or mark the terminal as overloaded for this tick
				if (sendTerm.isReady) {
					this.transfer(sendTerm, recvTerm, resource, requestAmount, `request for ${resource}`);
				} else {
					this.terminalOverload[sendTerm.room.name] = true;
				}
				return true;
			}
		}

		// If no colony is sufficient to send you the resources, try to divvy it up among several colonies
		if (opts.allowDivvying) {
			const MAX_SEND_REQUESTS = 3;
			const allPartners = _.flatten(partnerSets) as Colony[];
			// find all colonies that have more than target amt of resource and pick 3 with the most amt
			const validPartners: Colony[] = _(allPartners)
				.filter(partner => partner.assets[resource] > this.thresholds(partner, resource).target)
				.sortBy(partner => partner.assets[resource] - this.thresholds(partner, resource).target)
				.take(MAX_SEND_REQUESTS).value();

			// request bits of the amount until you have enough
			let remainingAmount = requestAmount;
			let sentSome = false;
			for (const partner of validPartners) {
				const sendTerm = partner.terminal!;
				const recvTerm = colony.terminal!;
				const amountPartnerCanSend = sendTerm.store[resource] - this.thresholds(partner, resource).target;
				const maxAmount = resource == RESOURCE_ENERGY ? TerminalNetworkV2.settings.maxEnergySendAmount
															  : TerminalNetworkV2.settings.maxResourceSendAmount;
				const sendAmount = Math.min(amountPartnerCanSend, remainingAmount, maxAmount);
				// Send the resources or mark the terminal as overloaded for this tick
				if (sendTerm.isReady) {
					const ret = this.transfer(sendTerm, recvTerm, resource, sendAmount, `request for ${resource}`);
					if (ret == OK) {
						remainingAmount -= sendAmount;
						sentSome = true;
					} else {
						this.terminalOverload[sendTerm.room.name] = true;
					}
				} else {
					this.terminalOverload[sendTerm.room.name] = true;
				}
				// If you've obtained what you need from the assortment of colonies, we're done
				if (remainingAmount <= 0) {
					return true;
				}
			}
			if (sentSome) { // if you were able to get at least some of resource by divvying, don't proceed to market
				return true;
			}
		}

		// If you are allowed to buy it on the market, try to do so
		if (opts.allowMarketBuy) {
			// Special cases if it's energy or boosts since these have higher buy thresholds
			if (resource == RESOURCE_ENERGY &&
				Game.market.credits < TraderJoe.settings.market.credits.canBuyEnergyAbove) {
				return false;
			}
			if (Abathur.isBoost(resource) &&
				Game.market.credits < TraderJoe.settings.market.credits.canBuyBoostsAbove) {
				return false;
			}
			// If you can still buy the thing, then buy then thing!
			const ret = Overmind.tradeNetwork.buy(colony.terminal!, resource, requestAmount);
			if (ret >= 0) {
				return true;
			}
		}

		// Can't handle this request instance!
		return false;
	}

	private handleProvideInstance(colony: Colony, resource: ResourceConstant, sendAmount: number,
								  partnerSets: Colony[][], opts: ProvideOpts): boolean {
		// Sometimes we don't necessarily want to push to other rooms - we usually do, but not always
		if (opts.allowPushToOtherRooms) {
			// Try to find the best single colony to send resources to
			for (const partners of partnerSets) {
				// First try to find a partner that has less resources than target - sendAmount and can hold more stuff
				let validPartners: Colony[] = _.filter(partners, partner =>
					partner.assets[resource] + sendAmount <= this.thresholds(partner, resource).target &&
					this.getRemainingSpace(partner) - sendAmount >= TerminalNetworkV2.settings.minColonySpace);
				// If that doesn't work, tfind partner where assets + sendAmount < target + tolerance and has space
				if (validPartners.length == 0) {
					validPartners = _.filter(partners, partner =>
						partner.assets[resource] + sendAmount <=
						this.thresholds(partner, resource).target + this.thresholds(colony, resource).tolerance &&
						this.getRemainingSpace(partner) - sendAmount >= TerminalNetworkV2.settings.minColonySpace);
				}
				// If that doesn't work, just try to find any room with space that won't become an activeProvider
				if (validPartners.length == 0) {
					validPartners = _.filter(partners, partner => {
						if (this.getRemainingSpace(partner) - sendAmount < TerminalNetworkV2.settings.minColonySpace) {
							return false;
						}
						const {target, surplus, tolerance} = this.thresholds(partner, resource);
						if (surplus != undefined) {
							return partner.assets[resource] + sendAmount < surplus;
						} else {
							return partner.assets[resource] + sendAmount <= target + tolerance;
						}
					});
				}
				// If you've found partners, send it to the best one
				if (validPartners.length > 0) {
					const bestPartner = minBy(validPartners, partner =>
						Game.market.calcTransactionCost(sendAmount, colony.name, partner.name)) as Colony;
					const sendTerm = colony.terminal!;
					const recvTerm = bestPartner.terminal!;
					const maxAmount = resource == RESOURCE_ENERGY ? TerminalNetworkV2.settings.maxEnergySendAmount
																  : TerminalNetworkV2.settings.maxResourceSendAmount;
					sendAmount = Math.min(sendAmount, sendTerm.store[resource], maxAmount);
					// Send the resources or mark the terminal as overloaded for this tick
					if (sendTerm.isReady) {
						this.transfer(sendTerm, recvTerm, resource, sendAmount, `provide instance for ${resource}`);
					} else {
						this.terminalOverload[sendTerm.room.name] = true;
					}
					return true;
				}
			}
		}

		// Sell on the market if that's an option
		if (opts.allowMarketSell) {
			const opts: TradeOpts = {};
			if (resource == RESOURCE_ENERGY || Abathur.isBaseMineral(resource)) {
				if (this.getRemainingSpace(colony) < TerminalNetworkV2.settings.minColonySpace) {
					opts.preferDirect = true;
				}
			}
			const ret = Overmind.tradeNetwork.sell(colony.terminal!, resource, sendAmount, opts);
			if (ret >= 0) {
				return true;
			}
		}

		// Can't handle this provide instance!
		return false;
	}

	private handleRequestors(requestors: { [resource: string]: Colony[] },
							 prioritizedPartners: { [resource: string]: Colony[] }[],
							 opts: RequestOpts = {}): void {
		_.defaults(opts, {
			allowDivvying          : false,
			sendTargetPlusTolerance: false,
			allowMarketBuy         : Game.market.credits > TraderJoe.settings.market.credits.canBuyAbove,
			recieveOnlyOncePerTick : false,
		});
		for (const resource of RESOURCE_EXCHANGE_ORDER) {
			for (const colony of (requestors[resource] || [])) {
				// Skip if the terminal if it has received in this tick if option is specified
				if (opts.receiveOnlyOncePerTick && colony.terminal && colony.terminal.hasReceived) {
					continue;
				}

				// Compute the request amount
				const {target, surplus, tolerance} = this.thresholds(colony, resource);
				let requestAmount = target - colony.assets[resource];
				if (opts.sendTargetPlusTolerance) {
					requestAmount += tolerance;
				}
				if (requestAmount <= 0) continue;

				// Generate a list of partner sets by picking the appropriate resource from the prioritizedPartners
				const partnerSets: Colony[][] = _.map(prioritizedPartners, partners => partners[resource] || []);

				const success = this.handleRequestInstance(colony, resource, requestAmount, partnerSets, opts);
				if (!success && Game.time % 5 == 0) {
					this.notify(`Unable to fulfill request instance from ${colony.print} ` +
								`for ${requestAmount} ${resource}`);
				}
			}
		}
	}

	private handleProviders(providers: { [resource: string]: Colony[] },
							prioritizedPartners: { [resource: string]: Colony[] }[],
							opts: ProvideOpts = {}): void {
		_.defaults(opts, {
			allowPushToOtherRooms: true,
			allowMarketSell      : true,
		});
		for (const resource of RESOURCE_EXCHANGE_ORDER) {
			for (const colony of (providers[resource] || [])) {
				// Skip if the terminal is not ready -  prevents trying to send twice in a single tick
				if (colony.terminal && !colony.terminal.isReady) {
					continue;
				}
				const sendAmount = colony.assets[resource] - this.thresholds(colony, resource).target;
				if (sendAmount <= 0) continue;
				// Generate a list of partner sets by picking the appropriate resource from the prioritizedPartners
				const partnerSets: Colony[][] = _.map(prioritizedPartners, partners => partners[resource] || []);

				const success = this.handleProvideInstance(colony, resource, sendAmount, partnerSets, opts);
				if (!success && Game.time % 5 == 0) {
					this.notify(`Unable to fulfill provide instance from ${colony.print} ` +
								`for ${sendAmount} ${resource}`);
				}
			}
		}
	}

	run(): void {
		// Assign states to each colony; manual state specification should have already been done in directive.init()
		this.assignColonyStates();

		// console.log(TN_STATE.activeProvider, TN_STATE.passiveProvider, TN_STATE.equilibrium, TN_STATE.passiveRequestor, TN_STATE.activeRequestor);
		// console.log(`${this.colonies.length} this.colonies = ${this.colonies}`);
		// console.log(`this.colonyStates = ${JSON.stringify(this.colonyStates)}`);
		// console.log(`this.activeProviders = ${JSON.stringify(_.mapValues(this.activeProviders, cols => _.map(cols, col => col.name)))}`);
		// console.log(`this.passiveProviders = ${JSON.stringify(_.mapValues(this.passiveProviders, cols => _.map(cols, col => col.name)))}`);
		// console.log(`this.equilibriumNodes = ${JSON.stringify(_.mapValues(this.equilibriumNodes, cols => _.map(cols, col => col.name)))}`);
		// console.log(`this.passiveRequestors = ${JSON.stringify(_.mapValues(this.passiveRequestors, cols => _.map(cols, col => col.name)))}`);
		// console.log(`this.activeRequestors = ${JSON.stringify(_.mapValues(this.activeRequestors, cols => _.map(cols, col => col.name)))}`);


		// Handle request types by descending priority: activeRequestors -> activeProviders -> passiveRequestors
		// (passiveProviders and equilibriumNodes have no action)
		this.handleRequestors(this.activeRequestors, [
			this.activeProviders,
			this.passiveProviders,
			this.equilibriumNodes,
			this.passiveRequestors,
		]);

		this.handleProviders(this.activeProviders, [
			this.activeRequestors,
			this.passiveRequestors,
			// this.equilibriumNodes, // probably don't include equilibrium nodes - want to have few rooms with orders
			// this.passiveProviders // shouldn't include passiveProviders - these already have too many
		]);

		this.handleRequestors(this.passiveRequestors, [
			this.activeProviders,
			this.passiveProviders,
		], {allowMarketBuy: false});

		// Record stats for this tick
		this.recordStats();

		this.summarize();

		// Display notifications
		if (this.notifications.length > 0) {
			log.info(`Terminal network activity: ` + alignedNewline + this.notifications.join(alignedNewline));
		}
	}

	private recordStats(): void {
		for (const colony of this.colonies) {
			if (colony.terminal) {
				this.stats.terminals.avgCooldown[colony.name] = exponentialMovingAverage(
					colony.terminal.cooldown,
					this.stats.terminals.avgCooldown[colony.name] || 0,
					TerminalNetworkV2.settings.terminalCooldownAveragingWindow);
				this.stats.terminals.overload[colony.name] = exponentialMovingAverage(
					this.terminalOverload[colony.name] ? 1 : 0,
					this.stats.terminals.overload[colony.name],
					CREEP_LIFE_TIME);
			}
		}
		// Rearrange and populate the states entries of stats
		const activeRequestors: { [colony: string]: string[] } = {};
		const passiveRequestors: { [colony: string]: string[] } = {};
		const equilibriumNodes: { [colony: string]: string[] } = {};
		const passiveProviders: { [colony: string]: string[] } = {};
		const activeProviders: { [colony: string]: string[] } = {};

		for (const [statsTier, thisTier] of [[activeRequestors, this.activeRequestors],
											 [passiveRequestors, this.passiveRequestors],
											 [equilibriumNodes, this.equilibriumNodes],
											 [passiveProviders, this.passiveProviders],
											 [activeProviders, this.activeProviders]]) {
			for (const resource in thisTier) {
				for (const colony of (<Colony[]>thisTier[resource])) {
					if (!statsTier[colony.name]) {
						statsTier[colony.name] = [resource];
					} else {
						(<string[]>statsTier[colony.name]).push(resource);
					}
				}
			}
			for (const colName in statsTier) { // sort the resources by the priority of exchange for consistency
				statsTier[colName] = _.sortBy(<string[]>statsTier[colName],
											  resource => _resourceExchangePrioritiesLookup[resource]);
			}
		}

		// Assign the transformed object to stats
		this.stats.states.activeRequestors = activeRequestors;
		this.stats.states.passiveRequestors = passiveRequestors;
		this.stats.states.equilibriumNodes = equilibriumNodes;
		this.stats.states.passiveProviders = passiveProviders;
		this.stats.states.activeProviders = activeProviders;

	}

	/**
	 * Prints the current state of the terminal network to the console
	 */
	private summarize(): void {
		const {activeRequestors, passiveRequestors, equilibriumNodes, passiveProviders, activeProviders} =
				  this.stats.states;
		let info: string = '\nTerminalNetwork Summary: \n';
		info += 'Active providers ---------------------------------------------------------------------\n';
		for (const colonyName in activeProviders) {
			info += `${bullet}${printRoomName(colonyName, true)}  ${activeProviders[colonyName]}\n`;
		}
		info += 'Passive providers --------------------------------------------------------------------\n';
		for (const colonyName in passiveProviders) {
			info += `${bullet}${printRoomName(colonyName, true)}  ${passiveProviders[colonyName]}\n`;
		}
		info += 'Equilibrium nodes --------------------------------------------------------------------\n';
		for (const colonyName in equilibriumNodes) {
			info += `${bullet}${printRoomName(colonyName, true)}  ${equilibriumNodes[colonyName]}\n`;
		}
		info += 'Passive requestors -------------------------------------------------------------------\n';
		for (const colonyName in passiveRequestors) {
			info += `${bullet}${printRoomName(colonyName, true)}  ${passiveRequestors[colonyName]}\n`;
		}
		info += 'Active requestors --------------------------------------------------------------------\n';
		for (const colonyName in activeRequestors) {
			info += `${bullet}${printRoomName(colonyName, true)}  ${activeRequestors[colonyName]}\n`;
		}
		console.log(info);
	}

}