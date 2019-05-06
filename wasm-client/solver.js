const depositsHelper = require('./depositsHelper').deposit
const contract = require('./contractHelper')
const toTaskInfo = require('./util/toTaskInfo')
const toSolutionInfo = require('./util/toSolutionInfo')
const midpoint = require('./util/midpoint')
const toIndices = require('./util/toIndices')
const assert = require('assert')
const recovery = require('./recovery')
const bigInt = require("big-integer")

const fsHelpers = require('./fsHelpers')

const contractsConfig = require('./util/contractsConfig')

function setup(web3) {
    return (async () => {
        const httpProvider = web3.currentProvider
        const config = await contractsConfig(web3)
        let incentiveLayer = await contract(httpProvider, config['incentiveLayer'])
        let fileSystem = await contract(httpProvider, config['fileSystem'])
        let tru = await contract(httpProvider, config['stake'])
        let disputeResolutionLayer = await contract(httpProvider, config['interactive'])
        return [incentiveLayer, fileSystem, disputeResolutionLayer, tru]
    })()
}

function c(x) { return bigInt(x.toString(10)) }

let solvers = []

module.exports = {
    get: () => solvers.filter(a => !a.exited()),
    init: async (os, account, test = false, recover = -1) => {

        let { web3, logger, throttle } = os
        let mcFileSystem = os.fileSystem

        let tasks = {}
        let games = {}
        let task_list = []
        let game_list = []

        let exiting = false
        let exited = false

        solvers.push({
            account:account,
            games: () => game_list, 
            tasks: () => task_list,
            exit: () => { exiting = true },
            exited: () => exited,
            exiting: () => exiting,
        })

        const merkleComputer = require("./merkle-computer")(logger, './../wasm-client/ocaml-offchain/interpreter/wasm')

        let bn = await web3.eth.getBlockNumber()

        logger.info(`Solver initialized at block ${bn}`)

        let [incentiveLayer, fileSystem, disputeResolutionLayer, tru] = await setup(web3)

        const config = await contractsConfig(web3)
        const WAIT_TIME = config.WAIT_TIME || 0
        const REWARD_LIMIT_raw = config.REWARD_LIMIT || 0
        const REWARD_LIMIT = bigInt(web3.utils.toWei(REWARD_LIMIT_raw.toString()))

        let recovery_mode = recover > 0
        let events = []

        const clean_list = []
        const RECOVERY_BLOCKS = recover

        if (recovery_mode) logger.info(`Recovering back to ${Math.max(0, bn - RECOVERY_BLOCKS)}`)

        function addEvent(name, evC, handler) {
            if (!evC) {
                logger.error(`SOLVER: ${name} event is undefined when given to addEvent`)
            } else {
                let ev = recovery_mode ? evC({}, { fromBlock: Math.max(0, bn - RECOVERY_BLOCKS) }) : evC()
                clean_list.push(ev)
                ev.watch(async (err, result) => {
                    // console.log(result)
                    if (result && recovery_mode) {
                        events.push({ event: result, handler })
                        console.log("SOLVER: Recovering", result.event, "at block", result.blockNumber)
                    }
                    else if (result) {
                        try {
                            await handler(result)
                        }
                        catch (e) {
                            // console.log(e)
                            logger.error(`SOLVER: Error while handling ${name} event ${JSON.stringify(result)}: ${e}`)
                        }
                    }
                    else console.log(err)
                })

            }
        }

        let helpers = fsHelpers.init(fileSystem, web3, mcFileSystem, logger, incentiveLayer, account, os.config)

        async function registerTask(result) {

            let taskID = result.args.taskID
            let minDeposit = result.args.minDeposit
            let reward = c(result.args.reward)

            let solutionInfo = toSolutionInfo(await incentiveLayer.getSolutionInfo.call(taskID))

            if (reward.lt(REWARD_LIMIT)) {
                logger.info("SOLVER: too low reward")
                return
            }
            if (throttle && Object.keys(tasks).length > throttle) return
            if (solutionInfo.solver != '0x0000000000000000000000000000000000000000') return

            if (config.solving_rate && config.solving_rate < Math.random()) {
                if (WAIT_TIME > 0) setTimeout(() => registerTask(result), WAIT_TIME)
                return
            }

            let secret = "0x" + helpers.makeSecret(taskID)

            if (!config.NO_AUTO_DEPOSIT) await depositsHelper(web3, incentiveLayer, tru, account, minDeposit)

            // console.log("deposit", minDeposit, taskID)
            // let depo = await incentiveLayer.debugDeposit.call(taskID, {from:account})
            // console.log("debug", depo.toString(10))

            // console.log("secret", secret, web3.utils.soliditySha3(secret))
            await incentiveLayer.registerForTask(taskID, web3.utils.soliditySha3(secret), { from: account, gas: 500000, gasPrice: web3.gp })

            // console.log("ok")

            if (!tasks[taskID]) {
                task_list.push(taskID)
                tasks[taskID] = {  }
            }

            tasks[taskID].minDeposit = minDeposit

                    // tasks[taskID].secret = secret
        }

        addEvent("TaskCreated", incentiveLayer.TaskCreated, async (result) => {

            if (exiting) return

            logger.log({
                level: 'info',
                message: `SOLVER: Task has been posted. Checking for availability.`
            })

            registerTask(result)

        })

        addEvent("SolverSelected", incentiveLayer.SolverSelected, async (result) => {
            let taskID = result.args.taskID
            let solver = result.args.solver

            if (account.toLowerCase() == solver.toLowerCase()) {

                //TODO: Need to read secret from persistence or else task is lost
                let taskInfo = toTaskInfo(await incentiveLayer.getTaskInfo.call(taskID))
                if (!tasks[taskID]) {
                    task_list.push(taskID)
                    tasks[taskID] = {}
                }
                tasks[taskID].taskInfo = taskInfo
                taskInfo.taskID = taskID

                logger.log({
                    level: 'info',
                    message: `SOLVER: Solving task ${taskID}`
                })

                let vm = await helpers.setupVMWithFS(taskInfo)

                assert(vm != undefined, "vm is undefined")

                let interpreterArgs = []
                let solution = await vm.executeWasmTask(interpreterArgs)
                tasks[taskID].solution = solution
                tasks[taskID].vm = vm
                tasks[taskID].interpreterArgs = interpreterArgs

                logger.info(`SOLVER: Committing solution ${solution.hash} (hashed ${web3.utils.soliditySha3(solution.hash)})`)

                try {
                    await incentiveLayer.commitSolution(taskID, web3.utils.soliditySha3(solution.hash), { from: account, gas: 1000000, gasPrice: web3.gp })

                    logger.log({
                        level: 'info',
                        message: `SOLVER: Submitted solution for task ${taskID} successfully`
                    })


                } catch (e) {
                    logger.info(`SOLVER: Unsuccessful submission for task ${taskID}`)
                    console.log(e)
                }
            }
            else if (tasks[taskID]) {
                logger.info(`SOLVER: I wasnt selected for task ${taskID}`)
                delete tasks[taskID]
            }

        })

        addEvent("SolutionsCommitted", incentiveLayer.SolutionsCommitted, async result => {
            logger.info("SOLVER: Committed a solution pair")
        })

        addEvent("SolutionRevealed", incentiveLayer.SolutionRevealed, async result => {
            logger.info("SOLVER: Revealed correct solution")
        })

        addEvent("EndRevealPeriod", incentiveLayer.EndRevealPeriod, async (result) => {
            let taskID = result.args.taskID

            if (tasks[taskID]) {
                let vm = tasks[taskID].solution.vm
                let secret = "0x" + helpers.makeSecret(taskID)
                console.log("secret", secret)
                await incentiveLayer.revealSolution(taskID, secret, vm.code, vm.input_size, vm.input_name, vm.input_data, { from: account, gas: 1000000, gasPrice: web3.gp })
                await helpers.uploadOutputs(taskID, tasks[taskID].vm)

                logger.log({
                    level: 'info',
                    message: `SOLVER: Revealed solution for task: ${taskID}. Outputs have been uploaded.`
                })
            }

        })

        addEvent("TaskFinalized", incentiveLayer.TaskFinalized, async (result) => {
            let taskID = result.args.taskID

            if (tasks[taskID]) {
                await incentiveLayer.unbondDeposit(taskID, { from: account, gas: 100000, gasPrice: web3.gp })
                delete tasks[taskID]
                logger.log({
                    level: 'info',
                    message: `SOLVER: Task ${taskID} finalized. Tried to unbond deposits.`
                })

            }

        })

        addEvent("TaskTimeout", incentiveLayer.TaskTimeout, async (result) => {
            let taskID = result.args.taskID

            if (tasks[taskID]) {
                await incentiveLayer.unbondDeposit(taskID, { from: account, gas: 100000, gasPrice: web3.gp })
                delete tasks[taskID]
                logger.log({
                    level: 'info',
                    message: `SOLVER: Task ${taskID} failed. Tried to unbond deposits.`
                })

            }

        })

        addEvent("SlashedDeposit", incentiveLayer.SlashedDeposit, async (result) => {
            let addr = result.args.account

            if (account.toLowerCase() == addr.toLowerCase()) {
                logger.info("SOLVER: Oops, I was slashed, hopefully this was a test")
            }

        })

        // DISPUTE

        addEvent("StartChallenge", disputeResolutionLayer.StartChallenge, async (result) => {
            let solver = result.args.p
            let gameID = result.args.gameID

            if (solver.toLowerCase() == account.toLowerCase()) {

                game_list.push(gameID)

                let taskID = await disputeResolutionLayer.getTask.call(gameID)

                logger.log({
                    level: 'info',
                    message: `SOLVER: Solution to task ${taskID} has been challenged`
                })

                //Initialize verification game
                let vm = tasks[taskID].vm

                // let solution = tasks[taskID].solution

                let initWasm = await vm.initializeWasmTask(tasks[taskID].interpreterArgs)
                let solution = await vm.getOutputVM(tasks[taskID].interpreterArgs)

                let lowStep = 0
                let highStep = solution.steps + 1

                games[gameID] = {
                    lowStep: lowStep,
                    highStep: highStep,
                    taskID: taskID
                }

                await disputeResolutionLayer.initialize(
                    gameID,
                    merkleComputer.getRoots(initWasm.vm),
                    merkleComputer.getPointers(initWasm.vm),
                    solution.steps + 1,
                    merkleComputer.getRoots(solution.vm),
                    merkleComputer.getPointers(solution.vm),
                    {
                        from: account,
                        gas: 1000000
                    }
                )

                logger.log({
                    level: 'info',
                    message: `SOLVER: Game ${gameID} has been initialized`
                })

                let indices = toIndices(await disputeResolutionLayer.getIndices.call(gameID))

                //Post response to implied midpoint query
                let stepNumber = midpoint(indices.low, indices.high)

                let stateHash = await tasks[taskID].vm.getLocation(stepNumber, tasks[taskID].interpreterArgs)

                await disputeResolutionLayer.report(gameID, indices.low, indices.high, [stateHash], { from: account, gasPrice: web3.gp })

                logger.log({
                    level: 'info',
                    message: `SOLVER: Reported state hash for step: ${stepNumber} game: ${gameID} low: ${indices.low} high: ${indices.high}`
                })

            }
        })

        addEvent("Queried", disputeResolutionLayer.Queried, async (result) => {
            let gameID = result.args.gameID
            let lowStep = result.args.idx1.toNumber()
            let highStep = result.args.idx2.toNumber()

            if (games[gameID]) {

                let taskID = games[gameID].taskID

                logger.log({
                    level: 'info',
                    message: `SOLVER: Received query Task: ${taskID} Game: ${gameID}`
                })

                if (lowStep + 1 != highStep) {
                    let stepNumber = midpoint(lowStep, highStep)

                    let stateHash = await tasks[taskID].vm.getLocation(stepNumber, tasks[taskID].interpreterArgs)

                    await disputeResolutionLayer.report(gameID, lowStep, highStep, [stateHash], { from: account, gasPrice: web3.gp })

                    logger.info(`SOLVER: Reported state for step ${stepNumber}`)

                } else {
                    //Final step -> post phases

                    // let lowStepState = await disputeResolutionLayer.getStateAt.call(gameID, lowStep)
                    // let highStepState = await disputeResolutionLayer.getStateAt.call(gameID, highStep)

                    let states = (await tasks[taskID].vm.getStep(lowStep, tasks[taskID].interpreterArgs)).states

                    await disputeResolutionLayer.postPhases(
                        gameID,
                        lowStep,
                        states,
                        {
                            from: account,
                            gas: 400000, gasPrice: web3.gp
                        }
                    )

                    logger.log({
                        level: 'info',
                        message: `SOLVER: Phases have been posted for game ${gameID}`
                    })

                }

            }
        })

        addEvent("SelectedPhase", disputeResolutionLayer.SelectedPhase, async (result) => {
            let gameID = result.args.gameID
            if (games[gameID]) {
                let taskID = games[gameID].taskID

                let lowStep = result.args.idx1.toNumber()
                let phase = result.args.phase.toNumber()

                logger.log({
                    level: 'info',
                    message: `SOLVER: Phase ${phase} for game ${gameID}`
                })


                let stepResults = await tasks[taskID].vm.getStep(lowStep, tasks[taskID].interpreterArgs)

                let phaseStep = merkleComputer.phaseTable[phase]

                let proof = stepResults[phaseStep]

                let merkle = proof.location || []

                let merkle2 = []

                if (proof.merkle) {
                    merkle = proof.merkle.list || proof.merkle.list1 || []
                    merkle2 = proof.merkle.list2 || []
                }

                let m = proof.machine || { reg1: 0, reg2: 0, reg3: 0, ireg: 0, vm: "0x00", op: "0x00" }
                let vm
                if (typeof proof.vm != "object") {
                    vm = {
                        code: "0x00",
                        stack: "0x00",
                        call_stack: "0x00",
                        calltable: "0x00",
                        globals: "0x00",
                        memory: "0x00",
                        calltypes: "0x00",
                        input_size: "0x00",
                        input_name: "0x00",
                        input_data: "0x00",
                        pc: 0,
                        stack_ptr: 0,
                        call_ptr: 0,
                        memsize: 0
                    }
                } else { vm = proof.vm }

                if (phase == 6 && parseInt(m.op.substr(-12, 2), 16) == 16) {
                    disputeResolutionLayer.callCustomJudge(
                        gameID,
                        lowStep,
                        m.op,
                        [m.reg1, m.reg2, m.reg3, m.ireg],
                        proof.merkle.result_state,
                        proof.merkle.result_size,
                        proof.merkle.list,
                        merkleComputer.getRoots(vm),
                        merkleComputer.getPointers(vm),
                        { from: account, gas: 500000, gasPrice: web3.gp }
                    )

                    //TODO
                    //merkleComputer.getLeaf(proof.merkle.list, proof.merkle.location)
                    //merkleComputer.storeHash(hash, proof.merkle.data)
                } else {
                    await disputeResolutionLayer.callJudge(
                        gameID,
                        lowStep,
                        phase,
                        merkle,
                        merkle2,
                        m.vm,
                        m.op,
                        [m.reg1, m.reg2, m.reg3, m.ireg],
                        merkleComputer.getRoots(vm),
                        merkleComputer.getPointers(vm),
                        { from: account, gas: 5000000, gasPrice: web3.gp }
                    )
                }

                logger.log({
                    level: 'info',
                    message: `SOLVER: Judge called for game ${gameID}`
                })

            }
        })

        addEvent("WinnerSelected", disputeResolutionLayer.WinnerSelected, async (result) => {
            let gameID = result.args.gameID
            delete games[gameID]
        })

        // This needs to be here for recovery to work
        addEvent("Reported", disputeResolutionLayer.Reported, async (result) => {
        })

        // Timeouts

        let busy_table = {}
        function busy(id) {
            let res = busy_table[id] && Date.now() < busy_table[id]
            return res
        }

        function working(id) {
            busy_table[id] = Date.now() + WAIT_TIME
        }

        async function handleGameTimeouts(gameID) {
            if (busy(gameID)) return
            if (await disputeResolutionLayer.gameOver.call(gameID)) {

                working(gameID)
                await disputeResolutionLayer.gameOver(gameID, { from: account, gasPrice: web3.gp })

                logger.log({
                    level: 'info',
                    message: `SOLVER: gameOver was called for game ${gameID}`
                })


            }
        }

        async function handleTimeouts(taskID) {
            // console.log("Handling task", taskID)

            // let deposit = await incentiveLayer.getBondedDeposit.call(taskID, account)
            // console.log("Solver deposit", deposit.toNumber(), account)
            if (busy(taskID)) {
                logger.info("SOLVER: Task busy")
                return
            }

            if (await incentiveLayer.endChallengePeriod.call(taskID)) {

                // console.log("Ending challenge")

                working(taskID)
                await incentiveLayer.endChallengePeriod(taskID, { from: account, gas: 100000, gasPrice: web3.gp })

                logger.log({
                    level: 'info',
                    message: `SOLVER: Ended challenge period for ${taskID}`
                })

            }

            let endReveal = await incentiveLayer.endRevealPeriod.call(taskID)

            if (endReveal) {

                working(taskID)
                await incentiveLayer.endRevealPeriod(taskID, { from: account, gas: 100000, gasPrice: web3.gp })

                logger.log({
                    level: 'info',
                    message: `SOLVER: Ended reveal period for ${taskID}`
                })

            }

            if (await incentiveLayer.canRunVerificationGame.call(taskID)) {

                working(taskID)
                await incentiveLayer.runVerificationGame(taskID, { from: account, gas: 1000000, gasPrice: web3.gp })

                logger.log({
                    level: 'info',
                    message: `SOLVER: Ran verification game for ${taskID}`
                })

            }

            if (await incentiveLayer.canFinalizeTask.call(taskID)) {

                // console.log("Tax should be", (await incentiveLayer.getTax.call(taskID)).toString())

                working(taskID)
                await incentiveLayer.finalizeTask(taskID, { from: account, gas: 1000000 , gasPrice: web3.gp})

                logger.log({
                    level: 'info',
                    message: `SOLVER: Finalized task ${taskID}`
                })

            }
        }

        async function recoverTask(taskID) {
            let taskInfo = toTaskInfo(await incentiveLayer.getTaskInfo.call(taskID))
            if (!tasks[taskID]) tasks[taskID] = {}
            tasks[taskID].taskInfo = taskInfo
            taskInfo.taskID = taskID

            logger.log({
                level: 'info',
                message: `SOLVER RECOVERY: Solving task ${taskID}`
            })

            let vm = await helpers.setupVMWithFS(taskInfo)

            assert(vm != undefined, "vm is undefined")

            let interpreterArgs = []
            let solution = await vm.executeWasmTask(interpreterArgs)
            tasks[taskID].solution = solution
            tasks[taskID].vm = vm
        }

        async function recoverGame(gameID) {
            let taskID = await disputeResolutionLayer.getTask.call(gameID)

            if (!tasks[taskID]) logger.error(`SOLVER FAILURE: haven't recovered task ${taskID} for game ${gameID}`)

            logger.log({
                level: 'info',
                message: `SOLVER RECOVERY: Solution to task ${taskID} has been challenged`
            })

            //Initialize verification game
            let solution = tasks[taskID].solution

            let lowStep = 0
            let highStep = solution.steps + 1

            games[gameID] = {
                lowStep: lowStep,
                highStep: highStep,
                taskID: taskID
            }
        }

        let ival

        let cleanup = () => {
            try {
                let empty = data => { }
                clean_list.forEach(ev => ev.stopWatching(empty))
                clearInterval(ival)
            } catch (e) {
                logger.error("SOLVER: Error when stopped watching events")
            }
            exited = true
            logger.info("SOLVER: Exiting")
        }

        let checkTasks = async () => {
            if (exiting && task_list.length == 0) cleanup()
            task_list = task_list.filter(a => tasks[a])
            game_list = game_list.filter(a => games[a])
            task_list.forEach(async t => {
                try {
                    await handleTimeouts(t)
                }
                catch (e) {
                    logger.error(`SOLVER: Error while handling timeouts of task ${t}: ${e.toString()}`)
                }
            })
            game_list.forEach(async g => {
                try {
                    await handleGameTimeouts(g)
                }
                catch (e) {
                    logger.error(`SOLVER: Error while handling timeouts of game ${g}: ${e.toString()}`)
                }
            })
            if (recovery_mode) {
                recovery_mode = false
                recovery.analyze(account, events, recoverTask, recoverGame, disputeResolutionLayer, incentiveLayer, game_list, task_list)
            }
        }

        ival = setInterval(checkTasks, 2000)

        return cleanup
    }
}
