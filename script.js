const ethAddress = localStorage.getItem('ethAddress');
const rpcSelection = localStorage.getItem('rpcSelection') || `https://www.noderpc.xyz/rpc-mainnet/public`; 

if (!ethAddress) {
    document.querySelector('.container').innerHTML = `
        <div class="alert alert-warning">
            Please set your Ethereum address in the <a href="settings.html">Settings</a> page.
        </div>
    `;
} 

web3 = new Web3(new Web3.providers.HttpProvider(rpcSelection));

const hexContractAddress = '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39'; // Same address for both chains.

let pairAddress = '0xF6DCdce0ac3001B2f67F750bc64ea5beB37B5824'; // Replace with your pair address

if (rpcSelection === 'https://www.noderpc.xyz/rpc-mainnet/public/') {    
    pairAddress = '0xF6DCdce0ac3001B2f67F750bc64ea5beB37B5824'; // ETH Pair of Hex/USDC
} else {
    pairAddress = '0x2cc85b82Ce181bce921dc4c0758CFd37a6BC240A'; // PulseChain Pair of Hex/USDC(From ETH)
}               
let pairContract = new web3.eth.Contract(pairABI, pairAddress);

const hexContractABI = HEX_CONTRACT_ABI;

let totalHex = 0.0;
let totalHexValue = 0.0;

const hexContract = new web3.eth.Contract(hexContractABI, hexContractAddress);

async function updateHexData() {
    //const [balance, priceData] = await Promise.all([
    const [balance, reserves] = await Promise.all([    
        hexContract.methods.balanceOf(ethAddress).call(),
        //fetch('https://api.coingecko.com/api/v3/simple/price?ids=hex&vs_currencies=usd&include_24hr_change=true').then(response => response.json())
        pairContract.methods.getReserves().call()
    ]);
    /*
    const hexBalance = balance / (10 ** 8);
    const hexPrice = priceData.hex.usd;
    const hexChange = priceData.hex.usd_24h_change;
    const hexValue = hexPrice * hexBalance;
    */
    //const balance = hexContract.methods.balanceOf(ethAddress).call();
    const hexBalance = balance / (10 ** 8);

    //const reserves = await pairContract.methods.getReserves().call();
    var hexReserves = 0;
    var usdcReserves = 0;
    if(rpcSelection === 'https://www.noderpc.xyz/rpc-mainnet/public/') {
        hexReserves = reserves._reserve0 / (10 ** 8); // HEX has 8 decimal places
        usdcReserves = reserves._reserve1 / (10 ** 6); // USDC has 6 decimal places
    } else {
        hexReserves = reserves._reserve1 / (10 ** 8); // HEX has 8 decimal places
        usdcReserves = reserves._reserve0 / (10 ** 6); // USDC has 6 decimal places
    }
    const exchangeRate =  usdcReserves / hexReserves;
    const hexPrice = exchangeRate;
    const hexValue = hexPrice * hexBalance;


    totalHex += parseFloat(hexBalance);
    totalHexValue += parseFloat(parseFloat(totalHex) * parseFloat(hexPrice));

    console.log('totalHex:', totalHex);
    console.log('totalHexValue:', totalHexValue);

    const formattedHexBalance = hexBalance.toLocaleString('en');
    //const hexPriceText = `Hex Price: $${hexPrice.toLocaleString('en', {minimumFractionDigits: 6, maximumFractionDigits: 8})} USD (${hexChange.toFixed(2)}%)`;
    const hexPriceText = `Hex Price: $${hexPrice.toLocaleString('en', {minimumFractionDigits: 6, maximumFractionDigits: 8})} USDC`;
    const hexValueText = `$${hexValue.toLocaleString('en', {minimumFractionDigits: 2, maximumFractionDigits: 2})} USDC`;

    const hexPriceContainer = document.querySelector('.hex-price-container');
    hexPriceContainer.innerHTML = `
        <p class="hex-price">${hexPriceText}</p>               
        <p class="hex-total-value">Total HEX Value: $<span id="hexTotalValue">Loading...</span> USD                    
        <p class="hex-total-amount">Total HEX: <span id="hexTotalAmount">Loading...</span></p>
    `;

    const hexBalanceContainer = document.querySelector('.hex-balance-container');
    hexBalanceContainer.innerHTML = `
        Wallet Balance:
        <p class="hex-value">${hexValueText}</p>
        <p>${formattedHexBalance} HEX</p>
    `;

    // Call displayActiveHexStakes() with the hexPrice argument
    displayActiveHexStakes(hexPrice).catch(error => {
        console.error('Error in displayActiveHexStakes:', error);
    });

    return hexValue;
}

updateHexData().catch(error => {
    console.error('Error in updateHexData:', error);
});

async function getActiveHexStakes(address) {
    const stakeCount = await hexContract.methods.stakeCount(address).call();
    const activeStakes = [];

    for (let i = 0; i < stakeCount; i++) {
        const stake = await hexContract.methods.stakeLists(address, i).call();
        if (stake.stakeId !== '0') {
            const currentDay = await hexContract.methods.currentDay().call();
            const stakingDays = Math.min(currentDay - stake.lockedDay, stake.stakedDays);

            let payout = 0;
            let bigPayDayBonus = 0;                    

            const dailyDataList = await hexContract.methods.dailyDataRange(stake.lockedDay, currentDay).call();

            dailyDataList.forEach(dailyDataPacked => {
                const dailyDataBigInt = BigInt(dailyDataPacked);
                const dayStakeSharesTotal = (dailyDataBigInt >> 72n) & ((1n << 72n) - 1n);
                const dayPayoutTotal = dailyDataBigInt & ((1n << 72n) - 1n);
                const scale = 1n * (10n ** 12n); // A large number to preserve precision
                const payoutPerTShare = (dayPayoutTotal * (1n ** 6n) * scale) / dayStakeSharesTotal;

                const actualPayoutPerTShare = Number(payoutPerTShare) / Number(scale);

                payout += Number(BigInt(stake.stakeShares) * BigInt(Math.round(actualPayoutPerTShare * (10 ** 12))) / (10n ** 20n));
            });

            // Get the big pay day bonus for the stake
            const globals = await hexContract.methods.globals().call();
            const unclaimedSatoshisTotal = 5700000000;  // this is an estimate.  <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<  I need exact amount...
            const heartsPerSatoshi = 10 ** 10; // This is a constant in the Hex contract
            const stakeSharesParam = stake.stakeShares; // This is the number of stake shares for the stake
            const BIG_PAY_DAY = 350;

            const dailyData = await hexContract.methods.dailyData(BIG_PAY_DAY).call();
            const dayStakeSharesTotal = dailyData.dayStakeSharesTotal; // This is the total number of stake shares for the entire day of the big pay day

            if (stake.lockedDay <= BIG_PAY_DAY && currentDay > BIG_PAY_DAY) {
                const bigPaySlice = unclaimedSatoshisTotal * heartsPerSatoshi * stakeSharesParam / dayStakeSharesTotal;
                bigPayDayBonus = bigPaySlice / (10**9); // + _calcAdoptionBonus(globals, bigPaySlice);
                
            }
            
            
            const stakeInfo = {
                index: i,
                principal: stake.stakedHearts / (10 ** 8),
                payout: payout.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                bigPayDay: bigPayDayBonus.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
                startDay: stake.lockedDay,
                endDay: parseInt(stake.lockedDay) + parseInt(stake.stakedDays)
            };
            activeStakes.push(stakeInfo);

            
            console.log('s.Principal:', parseFloat(stake.stakedHearts / (10 ** 8)));
            console.log('s.payout:', parseFloat(payout));
            console.log('s.bigPayDay:', parseFloat(bigPayDayBonus));

            totalHex += parseFloat(stake.stakedHearts / (10 ** 8)) + parseFloat(payout) + parseFloat(bigPayDayBonus);
           

            console.log('totalHex:', totalHex);

            
        }
    }

    return activeStakes;
}

function formatUsdValue(value) {
    if (value >= 1_000_000_000) {
        return `$${(value / 1_000_000_000).toFixed(1)}B`;
    } else if (value >= 1_000_000) {
        return `$${(value / 1_000_000).toFixed(1)}M`;
    } else if (value >= 1000) {
        return `$${(value / 1000).toFixed(1)}k`;
    } else {
        return `$${value.toFixed(2)}`;
    }
}

async function displayActiveHexStakes(hexPrice) {
    const stakes = await getActiveHexStakes(ethAddress);

    const hexStakesContainer = document.getElementById('hexStakesContainer');
    hexStakesContainer.innerHTML = '';

    for (const stake of stakes) {
        const tile = document.createElement('div');
        tile.className = 'stake-tile';

        const stakeInfo = document.createElement('div');
        tile.appendChild(stakeInfo);

        const index = document.createElement('p');
        index.textContent = `#: ${stake.index}`;
        stakeInfo.appendChild(index);

        const principal = document.createElement('p');
        principal.innerHTML = `Pri: ${stake.principal.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} HEX <span style="font-size: 0.8em;">(${formatUsdValue(stake.principal * hexPrice)})</span>`;
        stakeInfo.appendChild(principal);

        const interest = document.createElement('p');
        interest.innerHTML = `Int: ${stake.payout} HEX <span style="font-size: 0.8em;">(${formatUsdValue(parseFloat(stake.payout.replace(/,/g, '')) * hexPrice)})</span>`;
        stakeInfo.appendChild(interest);

        const bigPayDay = document.createElement('p');
        bigPayDay.innerHTML = `BPD: ${stake.bigPayDay} HEX <span style="font-size: 0.8em;">(${formatUsdValue(parseFloat(stake.bigPayDay.replace(/,/g, '')) * hexPrice)})</span>`;
        stakeInfo.appendChild(bigPayDay);
        
        const progressRing = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        progressRing.className = "progress-ring";
        progressRing.setAttribute("width", "50");
        progressRing.setAttribute("height", "50");

        const progressCircle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        progressCircle.className = "progress-ring__circle";
        progressCircle.setAttribute("stroke", "#946102"); // Updated color to gold
        progressCircle.setAttribute("stroke-width", "5");
        progressCircle.setAttribute("fill", "transparent");
        progressCircle.setAttribute("r", "24"); // Increased radius to 24 for a larger circle
        progressCircle.setAttribute("cx", "25");
        progressCircle.setAttribute("cy", "25");

        const circumference = 2 * Math.PI * progressCircle.getAttribute("r");

        const currentDay = await hexContract.methods.currentDay().call();
        const progress = (currentDay - stake.startDay) / (stake.endDay - stake.startDay);
        const dashoffset = circumference * (1 - progress);

        progressCircle.setAttribute("stroke-dasharray", `${circumference} ${circumference}`);
        progressCircle.setAttribute("stroke-dashoffset", dashoffset);

        progressRing.appendChild(progressCircle);

        const progressPercentage = document.createElementNS("http://www.w3.org/2000/svg", 'text');
        progressPercentage.setAttribute('x', '50%');
        progressPercentage.setAttribute('y', '50%');
        progressPercentage.setAttribute('text-anchor', 'middle');
        progressPercentage.setAttribute('dy', '.3em');
        progressPercentage.setAttribute('fill', 'white');

        

        progressPercentage.textContent = `${Math.round(progress * 100)}%`;
        progressRing.appendChild(progressPercentage);

        tile.appendChild(progressRing);
        hexStakesContainer.appendChild(tile);

        
    }

    totalHexValue = parseFloat(totalHex) * parseFloat(hexPrice);
           
    document.getElementById("hexTotalAmount").textContent = totalHex.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById("hexTotalValue").textContent = totalHexValue.toLocaleString('en', { minimumFractionDigits: 2, maximumFractionDigits: 2 });


}
