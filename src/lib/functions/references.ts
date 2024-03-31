import dedent from "dedent"
import { utils } from "ethers"
import { default as fse } from "fs-extra"

import { getArtifacts } from "@/lib/functions/artifacts"
import { getClient } from "@/lib/functions/client"
import { getSources } from "@/lib/functions/explorer"
import { logger } from "@/lib/logger"
import { Network } from "@/lib/types/config"
import {
    DynamicReference,
    References,
    StaticReference,
} from "@/lib/types/references"

const generateStaticReference = async (reference: StaticReference) => {
    let { network, name, abi, address, bytecode, deployedBytecode } = reference

    const referencePath = `./src/references/${network.key}/${name}`

    if (!fse.existsSync(referencePath))
        fse.mkdirSync(referencePath, {
            recursive: true,
        })

    const file = `${referencePath}/index.ts`

    if (fse.existsSync(file)) {
        logger.info(`Reference for ${name} already exists.`)
        return
    }

    /// * Turn UniswapV3Factory into UNISWAP_V3_FACTORY
    const bigName = name
        .split("")
        .map((letter, index) =>
            index === 0
                ? letter
                : letter === letter.toUpperCase()
                ? `_${letter}`
                : letter,
        )
        .join("")
        .toUpperCase()
        .replace(/ /g, "_")
        .replace(/_([0-9])/g, "$1")

    // ! If the bytecode was not provided, but we can retrieve it, then do so.
    // ? This is not the creationCode (deployedBytecode) but the actual bytecode before
    //   constructor arguments were provided. Notably, deployedBytecode comes from
    if (address && bytecode === undefined)
        bytecode = await getClient(network.rpc).getCode(address, "latest")

    const imports = [address === undefined ? "utils" : "Contract"]

    let contractInterface = dedent`
        // Autogenerated file for ${name} through "mev references". Do not edit directly.

        import { ${imports} } from 'ethers'

        export const ${bigName}_NAME = '${name}' as const
    `

    if (abi)
        contractInterface += dedent`\n
            export const ${bigName}_ABI = ${abi} as const
        `

    if (bytecode)
        contractInterface += dedent`\n
            export const ${bigName}_BYTECODE = '${bytecode}' as const
        `

    if (deployedBytecode)
        contractInterface += dedent`\n
            export const ${bigName}_DEPLOYED_BYTECODE = '${deployedBytecode}' as const
        `

    if (address !== undefined)
        contractInterface += dedent`\n
            export const ${bigName}_ADDRESS = '${address}' as const
        `

    if (abi) {
        /// * Create the Typescript interface for common offchain interactions.
        if (address !== undefined)
            contractInterface += dedent`\n
                export const ${bigName}_CONTRACT = new Contract(
                    ${bigName}_ADDRESS,
                    ${bigName}_ABI
                )

                export const ${bigName}_INTERFACE = ${bigName}_CONTRACT.interface
            `
        else
            contractInterface += dedent`\n
                export const ${bigName}_INTERFACE = new utils.Interface(
                    ${bigName}_ABI
                )
            `

        /// * Create a record of all the event topics for the contract.
        const protocolInterface = new utils.Interface(abi)
        const eventTopics: Record<string, string> = {}
        for (let [_, event] of JSON.parse(abi)
            .filter((x: any) => x.type === "event")
            .entries()) {
            eventTopics[event.name] = protocolInterface.getEventTopic(
                event.name,
            )
        }

        contractInterface += dedent`\n
            export const ${bigName}_EVENT_TOPICS = ${JSON.stringify(
                eventTopics,
            )} as const
        `
    }

    fse.writeFileSync(file, contractInterface)

    logger.info(`Generated ${referencePath}/index.ts`)

    // TODO: Used to the Solidity files were generated here using the ABI however due to
    //       continued issues and lack of support for contracts that are on versions earlier
    //       than 5.0 it results in a lot of issues. This will be revisted in the future.
    // NOTE: When you come back to this, probably easiest and best to directly retrieve
    //       the source code from Explorer and then generate the Solidity file from that.
    //       I am honestly not sure why I didn't just do that originally.
}

const generateDynamicReference = (reference: DynamicReference) => {
    let { network, name, source } = reference

    const referencePath = `./src/references/${network.key}/${name}`

    if (fse.existsSync(`${referencePath}/contracts`)) {
        logger.info(
            `Reference implementation contracts for ${name} already exist.`,
        )
        return
    }

    // * Remove the double curly braces from the source code.
    // ! I am not sure why this is happening, but it is solved now.
    source = source.replace("{{", "{")
    source = source.replace("}}", "}")

    try {
        let contractSources: {
            [key: string]: { content: string }
        } = {}

        /// * This handles the case where the source code is a JSON object
        ///   because the contract was verified with a collection of resources.
        if (source.startsWith("{") && source.endsWith("}")) {
            contractSources = JSON.parse(source).sources
        }
        /// * This is for when the contract was flattened and the source code is
        ///   a single string reference. Often done for older contracts.
        else {
            const fileName = `contracts/${name}.sol`
            contractSources = {
                [fileName]: { content: source },
            }
        }

        Object.entries(contractSources).forEach(([sourceKey, value]) => {
            const directory = `${referencePath}/${sourceKey
                .replace("./", "")
                .split("/")
                .slice(0, -1)
                .join("/")}`

            const filename = sourceKey.replace("./", "").split("/").slice(-1)[0]

            fse.mkdirSync(directory, { recursive: true })

            fse.writeFileSync(`${directory}/${filename}`, value.content)

            logger.info(`Generated ${directory}/${filename}`)
        })
    } catch (error: any) {
        logger.error(
            `Failed to parse the source code for ${name}: ${error.toString()}`,
        )
    }
}

export const generateReferences = async (network: Network) => {
    const sources = await getSources(network)
    const artifacts = await getArtifacts(network)

    const references: References = [...sources, ...artifacts]

    // * Generate all of the reference files.
    await Promise.all(
        references.map(
            async ({
                name,
                address,
                abi,
                bytecode,
                deployedBytecode,
                source,
            }) => {
                // ! Avoid generating files for empty-name contracts as something went wrong
                //   somewhere along the retrieval process.
                if (name === "") return

                // ! Generate the Typescript interface for the contract.
                if (abi !== undefined)
                    await generateStaticReference({
                        network,
                        name,
                        address,
                        abi,
                        bytecode,
                        deployedBytecode,
                    })

                // ! Generate the Solidity smart contract references.
                // * If `.source` is undefined, then it is a local artifact and the Solidity
                //   file was already created by the user.
                if (source !== undefined)
                    generateDynamicReference({ network, name, source })
            },
        ),
    )

    logger.success(`References generated for ${references.length} contracts.`)
}
