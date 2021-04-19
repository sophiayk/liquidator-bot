const Web3 = require("web3");
const Big = require("big.js");
const axios = require("axios");
const Service = require("./service");

const fuseSafeLiquidatorAbi = require(__dirname + '/abi/FuseSafeLiquidator.json');
const erc20Abi = require(__dirname + '/abi/ERC20.json');


const state = {};
state.service = new Service(web3, state);

// Set Big.js rounding mode to round down
Big.RM = 0;

var web3 = new Web3(new Web3.providers.HttpProvider(process.env.WEB3_HTTP_PROVIDER_URL));

var fuseSafeLiquidator = new web3.eth.Contract(fuseSafeLiquidatorAbi, process.env.FUSE_SAFE_LIQUIDATOR_CONTRACT_ADDRESS);


async function approveTokensToSafeLiquidator(erc20Address, amount) {
    // Build data
    var token = new web3.eth.Contract(erc20Abi, erc20Address);
    var data = token.methods.approve(amount).encodeABI();

    // Build transaction
    var tx = {
        from: process.env.ETHEREUM_ADMIN_ACCOUNT,
        to: erc20Address,
        value: 0,
        data: data,
        nonce: await web3.eth.getTransactionCount(process.env.ETHEREUM_ADMIN_ACCOUNT)
    };

    if (process.env.NODE_ENV !== "production") console.log("Signing and sending " + erc20Address + " approval transaction:", tx);

    // Estimate gas for transaction
    try {
        tx["gas"] = await web3.eth.estimateGas(tx);
    } catch (error) {
        throw "Failed to estimate gas before signing and sending " + erc20Address + " approval transaction: " + error;
    }

    // Sign transaction
    try {
        var signedTx = await web3.eth.accounts.signTransaction(tx, process.env.ETHEREUM_ADMIN_PRIVATE_KEY);
    } catch (error) {
        throw "Error signing " + erc20Address + " approval transaction: " + error;
    }

    // Send transaction
    try {
        var sentTx = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    } catch (error) {
        throw "Error sending " + erc20Address + " approval transaction: " + error;
    }

    console.log("Successfully sent " + erc20Address + " approval transaction:", sentTx);
    return sentTx;
}

async function sendTransactionToSafeLiquidator(method, params, value) {
    // Build data
    var data = fuseSafeLiquidator.methods[method](...params).encodeABI();

    // Build transaction
    var tx = {
        from: process.env.ETHEREUM_ADMIN_ACCOUNT,
        to: fuseSafeLiquidator.options.address,
        value: value,
        data: data,
        nonce: await web3.eth.getTransactionCount(process.env.ETHEREUM_ADMIN_ACCOUNT)
    };

    if (process.env.NODE_ENV !== "production") console.log("Signing and sending", method, "transaction:", tx);

    // Estimate gas for transaction
    try {
        tx["gas"] = await web3.eth.estimateGas(tx);
    } catch (error) {
        throw "Failed to estimate gas before signing and sending", method, "transaction: " + error;
    }

    // Sign transaction
    try {
        var signedTx = await web3.eth.accounts.signTransaction(tx, process.env.ETHEREUM_ADMIN_PRIVATE_KEY);
    } catch (error) {
        throw "Error signing", method, "transaction: " + error;
    }

    // Send transaction
    try {
        var sentTx = await web3.eth.sendSignedTransaction(signedTx.rawTransaction);
    } catch (error) {
        throw "Error sending", method, "transaction: " + error;
    }

    console.log("Successfully sent", method, "transaction:", sentTx);
    return sentTx;
}


async function liquidateUnhealthyBorrows() {
    var liquidations = await getPotentialLiquidations();

    for (const comptroller of Object.keys(liquidations))
        for (const liquidation of liquidations[comptroller])
            try {
                await sendTransactionToSafeLiquidator(liquidation[0], liquidation[1], liquidation[2]);
            } catch { }
}



async function getPotentialLiquidations() {

    var users = await state.service.listAccounts({ maxHealth: 1000000000000000000, minWorthInEth: 0.000005 });
    console.log('user-----------', users)
    var closeFactor = await state.service.getCloseFactor();
    var liquidationIncentive = await state.service.getLiquidationIncentive();
    var liquidations = [];
    for (var j = 0; j < users.length; j++) {
        var liquidation = await getPotentialLiquidation(users[j], closeFactor, liquidationIncentive);
        if (liquidation !== null) liquidations.push(liquidation);
    }

    if (liquidations.length > 0) return liquidations;
}




async function getPotentialLiquidation(borrower, closeFactor, liquidationIncentive) {
    var closeFactor = (new Big(closeFactor)).div(1e18);
    var liquidationIncentive = (new Big(liquidationIncentive)).div(1e18);

    // Get debt and collateral
    borrower = { ...borrower };
    borrower.debt = [];
    borrower.collateral = [];

    for (var asset of borrower.tokens) {
        asset = { ...asset };
        asset.underlyingPrice = await state.service.getUnderlyingPrice(asset.address);
        asset.underlyindDecimals = await state.service.getUnderlyingDecimals(asset.symbol);
        asset.borrowBalance = asset.supply_balance_underlying;
        asset.supplyBalance = asset.supply_balance_underlying;
        asset.underlyingSymbol = asset.symbol.substr(1);

        asset.borrowBalanceEth = new Big(asset.borrowBalance).mul(asset.underlyingPrice).div(1e36);
        asset.supplyBalanceEth = new Big(asset.supplyBalance).mul(underlyingPrice).div(1e36);

        assetsIn = await state.service.getAssetsIn(borrower);

        if (parseInt(asset.borrowBalance) > 0) borrower.debt.push(asset);
        if (assetsIn[asset] && parseInt(asset.supplyBalance) > 0) borrower.collateral.push(asset);
    }

    // Sort debt and collateral from highest to lowest ETH value
    borrower.debt.sort((a, b) => b.borrowBalanceEth.gt(a.borrowBalanceEth));
    borrower.collateral.sort((a, b) => b.supplyBalanceEth.gt(a.supplyBalanceEth));

    // Get debt and collateral prices
    const underlyingDebtPrice = (new Big(borrower.debt[0].underlyingPrice)).div((new Big(10)).pow(36 - borrower.debt[0].underlyingDecimals));
    const underlyingCollateralPrice = (new Big(borrower.collateral[0].underlyingPrice)).div((new Big(10)).pow(36 - borrower.collateral[0].underlyingDecimals));

    // Get liquidation amount
    var liquidationAmountScaled = (new Big(borrower.debt[0].borrowBalance)).mul(closeFactor);
    var liquidationAmount = liquidationAmountScaled.div((new Big(10)).pow(parseInt(borrower.debt[0].underlyingDecimals)));
    var liquidationValueEth = liquidationAmount.mul(underlyingDebtPrice);

    // Get seize amount
    var seizeAmountEth = liquidationValueEth.mul(liquidationIncentive);
    var seizeAmount = seizeAmountEth.div(underlyingCollateralPrice);

    // Check if actual collateral is too low to seize seizeAmount; if so, recalculate liquidation amount
    const actualCollateral = (new Big(borrower.collateral[0].supplyBalance)).div((new Big(10)).pow(parseInt(borrower.collateral[0].underlyingDecimals)));

    if (seizeAmount.gt(actualCollateral)) {
        seizeAmount = actualCollateral;
        seizeAmountEth = seizeAmount.mul(underlyingCollateralPrice);
        liquidationValueEth = seizeAmountEth.div(liquidationIncentive);
        liquidationAmount = liquidationValueEth.div(underlyingDebtPrice);
        liquidationAmountScaled = liquidationAmount.mul((new Big(10)).pow(parseInt(borrower.debt[0].underlyingDecimals)));
    }

    // Convert liquidationAmountScaled to string
    liquidationAmountScaled = liquidationAmountScaled.toFixed(0);

    // Depending on liquidation strategy
    if (process.env.LIQUIDATION_STRATEGY === "") {
        // Estimate gas usage
        try {
            if (borrower.debt[0].underlyingSymbol === 'OKT') {
                var expectedGasAmount = await fuseSafeLiquidator.methods.safeLiquidate(borrower.account, borrower.debt[0].cToken, borrower.collateral[0].cToken, 0, exchangeToTokenAddress).estimateGas({ gas: 1e9, value: liquidationAmountScaled, from: process.env.ETHEREUM_ADMIN_ACCOUNT });
            } else {
                var expectedGasAmount = await fuseSafeLiquidator.methods.safeLiquidate(borrower.account, liquidationAmountScaled, borrower.debt[0].cToken, borrower.collateral[0].cToken, 0, exchangeToTokenAddress).estimateGas({ gas: 1e9, from: process.env.ETHEREUM_ADMIN_ACCOUNT });
            }
        } catch {
            var expectedGasAmount = 600000;
        }

        // Get gas fee
        const gasPrice = new Big(await web3.eth.getGasPrice()).div(1e18);
        const expectedGasFee = gasPrice.mul(expectedGasAmount);

        // Get min seize
        var minEthSeizeAmountBreakEven = expectedGasFee.add(liquidationValueEth);
        var minEthSeizeAmount = minEthSeizeAmountBreakEven.add(process.env.MINIMUM_PROFIT);
        var minSeizeAmount = minEthSeizeAmount.div(outputPrice);
        var minSeizeAmountScaled = minSeizeAmount.mul((new Big(10)).pow(outputDecimals)).toFixed(0);

        // Check expected seize against minSeizeAmount
        if (seizeAmount.lt(minSeizeAmount)) return null;

        // Return transaction
        if (borrower.debt[0].underlyingSymbol === 'OKT') {
            return ["safeLiquidate", [borrower.account, borrower.debt[0].cToken, borrower.collateral[0].cToken, minSeizeAmountScaled, exchangeToTokenAddress], liquidationAmountScaled];
        } else {
            return ["safeLiquidate", [borrower.account, liquidationAmountScaled, borrower.debt[0].cToken, borrower.collateral[0].cToken, minSeizeAmountScaled, exchangeToTokenAddress], 0];
        }



    } else if (process.env.LIQUIDATION_STRATEGY === "uniswap") {
        // Estimate gas usage
        try {
            if (borrower.debt[0].underlyingSymbol === 'ETH') {
                var expectedGasAmount = await fuseSafeLiquidator.methods.safeLiquidateToEthWithFlashLoan(borrower.account, liquidationAmountScaled, borrower.debt[0].cToken, borrower.collateral[0].cToken, 0, exchangeToTokenAddress).estimateGas({ gas: 1e9, from: process.env.ETHEREUM_ADMIN_ACCOUNT });
            } else {
                var expectedGasAmount = await fuseSafeLiquidator.methods.safeLiquidateToTokensWithFlashLoan(borrower.account, liquidationAmountScaled, borrower.debt[0].cToken, borrower.collateral[0].cToken, 0, exchangeToTokenAddress).estimateGas({ gas: 1e9, from: process.env.ETHEREUM_ADMIN_ACCOUNT });
            }
        } catch {
            var expectedGasAmount = 750000;
        }

        // Get gas fee
        const gasPrice = new Big(await web3.eth.getGasPrice()).div(1e18);
        const expectedGasFee = gasPrice.mul(expectedGasAmount);

        // Get min profit
        var minOutputEth = (new Big(process.env.MINIMUM_PROFIT_ETH)).add(expectedGasFee);
        var minProfitAmountScaled = minOutputEth.div(outputPrice).mul((new Big(10)).pow(outputDecimals)).toFixed(0);

        // Return transaction
        if (borrower.debt[0].underlyingSymbol === 'ETH') {
            return ["safeLiquidateToEthWithFlashLoan", [borrower.account, liquidationAmountScaled, borrower.debt[0].cToken, borrower.collateral[0].cToken, minProfitAmountScaled, exchangeToTokenAddress], 0];
        } else {
            return ["safeLiquidateToTokensWithFlashLoan", [borrower.account, liquidationAmountScaled, borrower.debt[0].cToken, borrower.collateral[0].cToken, minProfitAmountScaled, exchangeToTokenAddress], 0];
        }
    } else throw "Invalid liquidation strategy";
}

async function getPrice(tokenAddress) {
    tokenAddress = tokenAddress.toLowerCase();

    // Get ETH-based price of an ERC20 via CoinGecko
    var decoded = (await axios.get('https://api.coingecko.com/api/v3/simple/token_price/ethereum', {
        params: {
            vs_currencies: "eth",
            contract_addresses: tokenAddress
        }
    })).data;
    if (!decoded || !decoded[tokenAddress]) throw "Failed to decode price of " + tokenAddress + " from CoinGecko";
    return decoded[tokenAddress].eth;
}

var currencyDecimalsCache = {};
var currencyPriceCache = {};

async function getCurrencyEthPriceAndDecimals(tokenAddressOrEth) {
    // Quick return for ETH
    if (tokenAddressOrEth === "ETH") return [1, 18];

    // Lowercase token address
    tokenAddressOrEth = tokenAddressOrEth.toLowerCase();

    // Get price (from cache if possible)
    if (currencyPriceCache[tokenAddressOrEth] === undefined || currencyPriceCache[tokenAddressOrEth].lastUpdated < (epochNow - (60 * 15))) {
        currencyPriceCache[tokenAddressOrEth] = {
            lastUpdated: epochNow,
            value: await getPrice(tokenAddressOrEth)
        };
    }

    // Get decimals (from cache if possible)
    if (currencyDecimalsCache[tokenAddressOrEth] === undefined) currencyDecimalsCache[tokenAddressOrEth] = tokenAddressOrEth === "ETH" ? 18 : parseInt(await (new web3.eth.Contract(erc20Abi, tokenAddressOrEth)).methods.decimals().call());
    var epochNow = (new Date()).getTime() / 1000;

    return [currencyPriceCache[tokenAddressOrEth].value, currencyDecimalsCache[tokenAddressOrEth]];
}

// Liquidate unhealthy borrows and repeat every LIQUIDATION_INTERVAL_SECONDS
async function liquidateAndRepeat() {
    await liquidateUnhealthyBorrows();
    setTimeout(liquidateAndRepeat, process.env.LIQUIDATION_INTERVAL_SECONDS * 1000);
}

(async function () {
    if (process.env.LIQUIDATION_STRATEGY === "") for (const tokenAddress of process.env.SUPPORTED_INPUT_CURRENCIES.split(',')) if (tokenAddress !== "ETH") await approveTokensToSafeLiquidator(tokenAddress, web3.utils.toBN(2).pow(web3.utils.toBN(256)).subn(1));
    liquidateAndRepeat();
})();
