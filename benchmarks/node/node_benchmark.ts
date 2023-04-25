import percentile from "percentile";
import { stdev } from "stats-lite";
import { createClient } from "redis";
import { AsyncClient, SocketConnection, setLoggerConfig } from "babushka-rs";
import commandLineArgs from "command-line-args";
import { writeFileSync } from "fs";

enum ChosenAction {
    GET_NON_EXISTING,
    GET_EXISTING,
    SET,
}
// Demo - Setting the internal logger to log every log that has a level of info and above, and save the logs to the first.log file.
setLoggerConfig("info", "first.log");

function getAddress(host: string, port?: number): string {
    const PORT = 6379;
    return `${host}:${port === undefined ? PORT : port}`;
}

function getAddressWithProtocol(
    host: string,
    useTLS: boolean,
    port?: number
): string {
    const PORT = 6379;
    const protocol = useTLS ? "rediss" : "redis";
    return `${protocol}://${getAddress(host, port ?? PORT)}`;
}

const PROB_GET = 0.8;
const PROB_GET_EXISTING_KEY = 0.8;
const SIZE_GET_KEYSPACE = 3750000; // 3.75 million
const SIZE_SET_KEYSPACE = 3000000; // 3 million

let started_tasks_counter = 0;
const running_tasks: Promise<void>[] = [];
const bench_json_results: object[] = [];

interface IAsyncClient {
    set: (key: string, value: string) => Promise<string | "OK" | null>;
    get: (key: string) => Promise<string | null>;
}

function generate_value(size: number): string {
    return "0".repeat(size);
}

function generate_key_set(): string {
    return (Math.floor(Math.random() * SIZE_SET_KEYSPACE) + 1).toString();
}
function generate_key_get(): string {
    const range = SIZE_GET_KEYSPACE - SIZE_SET_KEYSPACE;
    return Math.floor(Math.random() * range + SIZE_SET_KEYSPACE + 1).toString();
}

function choose_action(): ChosenAction {
    if (Math.random() > PROB_GET) {
        return ChosenAction.SET;
    }
    if (Math.random() > PROB_GET_EXISTING_KEY) {
        return ChosenAction.GET_NON_EXISTING;
    }
    return ChosenAction.GET_EXISTING;
}

function calculate_latency(latency_list: number[], percentile_point: number) {
    const percentile_calculation = percentile(percentile_point, latency_list);
    const percentile_value = Array.isArray(percentile_calculation)
        ? percentile_calculation[0]
        : percentile_calculation;
    return Math.round(percentile_value * 100.0) / 100.0; // round to 2 decimal points
}

function print_results(resultsFile: string) {
    writeFileSync(resultsFile, JSON.stringify(bench_json_results));
}

async function redis_benchmark(
    clients: IAsyncClient[],
    total_commands: number,
    data: string,
    action_latencies: Record<ChosenAction, number[]>
) {
    while (started_tasks_counter < total_commands) {
        started_tasks_counter += 1;
        const chosen_action = choose_action();
        const tic = process.hrtime();
        const client = clients[started_tasks_counter % clients.length];
        switch (chosen_action) {
            case ChosenAction.GET_EXISTING:
                await client.get(generate_key_get());
                break;
            case ChosenAction.GET_NON_EXISTING:
                await client.get(generate_key_get());
                break;
            case ChosenAction.SET:
                await client.get(generate_key_get());
                break;
        }
        const toc = process.hrtime(tic);
        const latency_list = action_latencies[chosen_action];
        latency_list.push(toc[0] * 1000 + toc[1] / 1000000);
    }
}

async function create_bench_tasks(
    clients: IAsyncClient[],
    total_commands: number,
    num_of_concurrent_tasks: number,
    data: string,
    action_latencies: Record<ChosenAction, number[]>
) {
    started_tasks_counter = 0;
    const tic = process.hrtime();
    for (let i = 0; i < num_of_concurrent_tasks; i++) {
        running_tasks.push(
            redis_benchmark(clients, total_commands, data, action_latencies)
        );
    }
    await Promise.all(running_tasks);
    const toc = process.hrtime(tic);
    return toc[0] + toc[1] / 1000000000;
}

function latency_results(
    prefix: string,
    latencies: number[]
): Record<string, number> {
    const result: Record<string, number> = {};
    result[prefix + "_p50_latency"] = calculate_latency(latencies, 50);
    result[prefix + "_p90_latency"] = calculate_latency(latencies, 90);
    result[prefix + "_p99_latency"] = calculate_latency(latencies, 99);
    result[prefix + "_average_latency"] =
        latencies.reduce((a, b) => a + b, 0) / latencies.length;
    result[prefix + "_std_dev"] = stdev(latencies);

    return result;
}

async function run_clients(
    clients: IAsyncClient[],
    client_name: string,
    total_commands: number,
    num_of_concurrent_tasks: number,
    data_size: number,
    data: string
) {
    const now = new Date();
    console.log(
        `Starting ${client_name} data size: ${data_size} concurrency: ${num_of_concurrent_tasks} client count: ${
            clients.length
        } ${now.toLocaleTimeString()}`
    );
    const action_latencies = {
        [ChosenAction.SET]: [],
        [ChosenAction.GET_NON_EXISTING]: [],
        [ChosenAction.GET_EXISTING]: [],
    };

    const time = await create_bench_tasks(
        clients,
        total_commands,
        num_of_concurrent_tasks,
        data,
        action_latencies
    );
    const tps = Math.round(started_tasks_counter / time);

    const get_non_existing_latencies =
        action_latencies[ChosenAction.GET_NON_EXISTING];
    const get_non_existing_latency_results = latency_results(
        "get_non_existing",
        get_non_existing_latencies
    );

    const get_existing_latencies = action_latencies[ChosenAction.GET_EXISTING];
    const get_existing_latency_results = latency_results(
        "get_existing",
        get_existing_latencies
    );

    const set_latencies = action_latencies[ChosenAction.SET];
    const set_latency_results = latency_results("set", set_latencies);

    const json_res = {
        client: client_name,
        num_of_tasks: num_of_concurrent_tasks,
        data_size,
        tps,
        clientCount: clients.length,
        ...set_latency_results,
        ...get_existing_latency_results,
        ...get_non_existing_latency_results,
    };
    bench_json_results.push(json_res);
}

function createClients(
    clientCount: number,
    createAction: () => Promise<IAsyncClient>
): Promise<IAsyncClient[]> {
    const creationActions = Array.from({ length: clientCount }, () =>
        createAction()
    );
    return Promise.all(creationActions);
}

async function main(
    total_commands: number,
    num_of_concurrent_tasks: number,
    data_size: number,
    clients_to_run: "all" | "ffi" | "socket" | "babushka",
    host: string,
    clientCount: number,
    useTLS: boolean
) {
    const data = generate_value(data_size);
    if (
        clients_to_run == "ffi" ||
        clients_to_run == "all" ||
        clients_to_run == "babushka"
    ) {
        const clients = await createClients(
            clientCount,
            () =>
                new Promise((resolve) =>
                    resolve(
                        AsyncClient.CreateConnection(
                            getAddressWithProtocol(host, useTLS)
                        )
                    )
                )
        );
        await run_clients(
            clients,
            "babushka FFI",
            total_commands,
            num_of_concurrent_tasks,
            data_size,
            data
        );
    }

    if (
        clients_to_run == "socket" ||
        clients_to_run == "all" ||
        clients_to_run == "babushka"
    ) {
        const clients = await createClients(clientCount, () =>
            SocketConnection.CreateConnection({
                addresses: [{ host }],
                useTLS,
            })
        );
        await run_clients(
            clients,
            "babushka socket",
            total_commands,
            num_of_concurrent_tasks,
            data_size,
            data
        );
        clients.forEach((client) => (client as SocketConnection).dispose());
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (clients_to_run == "all") {
        await run_clients(
            await createClients(clientCount, async () => {
                const node_redis_client = createClient({
                    url: getAddressWithProtocol(host, useTLS),
                });
                await node_redis_client.connect();
                return node_redis_client;
            }),
            "node_redis",
            total_commands,
            num_of_concurrent_tasks,
            data_size,
            data
        );
    }
}

const optionDefinitions = [
    { name: "resultsFile", type: String },
    { name: "dataSize", type: String },
    { name: "concurrentTasks", type: String, multiple: true },
    { name: "clients", type: String },
    { name: "host", type: String },
    { name: "clientCount", type: String, multiple: true },
    { name: "tls", type: Boolean },
];
const receivedOptions = commandLineArgs(optionDefinitions);

const number_of_iterations = (num_of_concurrent_tasks: number) =>
    Math.min(Math.max(100000, num_of_concurrent_tasks * 10000), 10000000*100);

Promise.resolve() // just added to clean the indentation of the rest of the calls
    .then(async () => {
        const data_size = parseInt(receivedOptions.dataSize);
        const concurrent_tasks: string[] = receivedOptions.concurrentTasks;
        const clients_to_run = receivedOptions.clients;
        const clientCount: string[] = receivedOptions.clientCount;
        const lambda: (
            numOfClients: string,
            concurrentTasks: string
        ) => [number, number, number] = (
            numOfClients: string,
            concurrentTasks: string
        ) => [parseInt(concurrentTasks), data_size, parseInt(numOfClients)];
        const product: [number, number, number][] = concurrent_tasks
            .flatMap((concurrentTasks: string) =>
                clientCount.map((clientCount) =>
                    lambda(clientCount, concurrentTasks)
                )
            )
            .filter(
                ([concurrent_tasks, _, clientCount]) =>
                    clientCount <= concurrent_tasks
            );

        for (const [concurrent_tasks, data_size, clientCount] of product) {
            await main(
                number_of_iterations(concurrent_tasks),
                concurrent_tasks,
                data_size,
                clients_to_run,
                receivedOptions.host,
                clientCount,
                receivedOptions.tls
            );
        }

        print_results(receivedOptions.resultsFile);
    })
    .then(() => {
        process.exit(0);
    });
