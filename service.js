const Promise = require('bluebird');
const superagent = require('superagent');
const Web3 = require("web3");

const comptrollerAbi = require(__dirname + '/abi/Comptroller.json');
const priceOracleAbi = require(__dirname + '/abi/PriceOracle.json')
const decimals = {};


class Service {
    constructor(web3, state) {
        let cache = {};
        let priceCache = {};

        this._fetchAccountService = async function ({ borrowerAccounts, maxHealth, minWorthInEth }) {
            const requestData = {
                page_number: 1, page_size: 1000,
            };

            requestData.max_health = maxHealth;
            if (minWorthInEth) requestData.min_borrow_value_in_eth = minWorthInEth;
            if (borrowerAccounts && borrowerAccounts.length) requestData.addresses = borrowerAccounts;

            let accounts = [];
            let error;
            while (!error) {
                let result;
                try {
                    result = await superagent.get(process.env.SPIRALX_HTTP_ACCOUNT_SERVICE)
                        .set('Accept', 'application/json')
                        .query(requestData);
                } catch (e) {
                    throw new Error("Error calling from compound API: " + e);
                }
                if (!result.body.error) {
                    accounts = accounts.concat(result.body.accounts);
                    let { total_pages } = result.body.pagination_summary;
                    if (accounts.length === 0 || requestData.page_number === total_pages) break;
                    requestData.page_number++;
                } else {
                    error = result.body.error;
                    throw new Error("Error return from compound API: " + error);
                }
            }
            return accounts;
        };

        this.listAccounts = async function ({ borrowerAccounts, maxHealth, minWorthInEth, maxResults }) {
            let accounts = await this._fetchAccountService({ borrowerAccounts, maxHealth, minWorthInEth });
            accounts = _.chain(accounts)
                .map(account => {
                    return {
                        address: account.address,
                        tokens: account.tokens,
                        health: account.health,
                        borrowValue: Service.parseNumber(account.total_borrow_value_in_eth.value, 4)
                    }
                })
                .sortBy(account => -account.borrowValue)
                .first(maxResults ? maxResults : 10)
                .value();
            return accounts;
        }

        this.getComptroller = async function () {
            comptroller = new web3.eth.Contract(comptrollerAbi, process.env.COMPTROLLER_CONTRACT_ADDRESS);
            return comptroller;
        }

        this.getPriceOracle = async function () {
            priceOracle = new web3.eth.Contract(priceOracleAbi, process.env.ORACLE_CONTRACT_ADDRESS);
            return priceOracle;
        }

        this.getCloseFactor = async function () {
            if (!_.has(cache, 'closeFactor')) {
                const comptroller = await this.getComptroller();
                cache.closeFactor = new BN(await comptroller.methods.closeFactorMantissa().call());
                setTimeout(function () {
                    delete cache.closeFactor;
                }, 600 /* secs */ * 1000);
            }
            return cache.closeFactor;
        }

        this.getLiquidationIncentive = async function () {
            if (!_.has(cache.liquidationIncentive)) {
                const comptroller = await this.getComptroller();
                cache.liquidationIncentive = new BN(await comptroller.methods.liquidationIncentiveMantissa().call());
                setTimeout(function () {
                    delete cache.liquidationIncentive;
                }, 600 /* secs */ * 1000);
            }
            return cache.liquidationIncentive;
        }

        this.getUnderlyingPrice = async function ({ cTokenAddress }) {
            if (!_.has(priceCache[cTokenAddress])) {
                let PriceOracle = await this.getPriceOracle();
                let price = await PriceOracle.methods.getUnderlyingPrice(cTokenAddress).call();
                priceCache[cTokenAddress] = price;
                setTimeout(function () {
                    delete priceCache[cTokenAddress];
                }, 60 /* secs */ * 1000);
            }
            return priceCache[cTokenAddress];
        }

        this.getAssetsIn = async function ({ account }) {
            return this.comptroller.methods.getAssetsIn(account).call();
        }

        this.getUnderlyingDecimals = function (sysmbol) {
            if (!decimals[sysmbol]) {
                switch (sysmbol) {
                    case 'cBTCK':
                    case 'cUSDK':
                    case 'cLTCK':
                    case 'cOKB':
                    case 'cETHK':
                    case 'cDOTK':
                        decimals[contractName] = 10;
                        break;
                    case 'cOKT':
                        decimals[contractName] = 18;
                        break;
                    default:
                        throw new Error('Unknown sysmbol ' + sysmbol);
                }
            }
        }

        Service
            .parseNumber = function (str, decimals) {
                if (decimals === null || decimals === undefined) decimals = 9;
                str = str || "0.0";
                let [whole, fraction] = str.toString().split('.');
                fraction = fraction || "0";
                return Number.parseFloat(whole + "." + fraction.substr(0, decimals));
            }


        module.exports = Service;