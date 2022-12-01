use napi::bindgen_prelude::ToNapiValue;
use napi::{Env, Error, JsObject, Result, Status};
use napi_derive::napi;
use redis::aio::MultiplexedConnection;
use redis::socket_listener::headers::HEADER_END;
use redis::socket_listener::start_socket_listener;
use redis::{AsyncCommands, RedisError, RedisResult};
use std::str;
use tokio::runtime::{Builder, Runtime};

// TODO - this repetition will become unmaintainable. We need to do this in macros.
#[napi]
pub enum RequestType {
    /// Type of a server address request
    ServerAddress = 1,
    /// Type of a get string request.
    GetString = 2,
    /// Type of a set string request.
    SetString = 3,
}

// TODO - this repetition will become unmaintainable. We need to do this in macros.
#[napi]
pub enum ResponseType {
    /// Type of a response that returns a null.
    Null = 0,
    /// Type of a response that returns a string.
    String = 1,
    /// Type of response containing an error that impacts a single request.
    RequestError = 2,
    /// Type of response containing an error causes the connection to close.
    ClosingError = 3,
}

// TODO - this repetition will become unmaintainable. We need to do this in macros.
#[napi]
pub const HEADER_LENGTH_IN_BYTES: u32 = HEADER_END as u32;

#[napi]
struct AsyncClient {
    #[allow(dead_code)]
    connection: MultiplexedConnection,
    runtime: Runtime,
}

fn to_js_error(err: RedisError) -> Error {
    napi::Error::new(Status::Unknown, err.to_string())
}

fn to_js_result<T>(result: RedisResult<T>) -> Result<T> {
    result.map_err(to_js_error)
}

#[napi]
impl AsyncClient {
    #[napi(js_name = "CreateConnection")]
    #[allow(dead_code)]
    pub fn create_connection(connection_address: String) -> Result<AsyncClient> {
        let runtime = Builder::new_multi_thread()
            .enable_all()
            .worker_threads(1)
            .thread_name("Babushka node thread")
            .build()?;
        let _runtime_handle = runtime.enter();
        let client = to_js_result(redis::Client::open(connection_address))?;
        let connection = to_js_result(runtime.block_on(client.get_multiplexed_async_connection()))?;
        Ok(AsyncClient {
            connection,
            runtime,
        })
    }

    #[napi(ts_return_type = "Promise<string | null>")]
    #[allow(dead_code)]
    pub fn get(&self, env: Env, key: String) -> Result<JsObject> {
        let (deferred, promise) = env.create_deferred()?;

        let mut connection = self.connection.clone();
        self.runtime.spawn(async move {
            let result: Result<Option<String>> = to_js_result(connection.get(key).await);
            match result {
                Ok(value) => deferred.resolve(|_| Ok(value)),
                Err(e) => deferred.reject(e),
            }
        });

        Ok(promise)
    }

    #[napi(ts_return_type = "Promise<void>")]
    #[allow(dead_code)]
    pub fn set(&self, env: Env, key: String, value: String) -> Result<JsObject> {
        let (deferred, promise) = env.create_deferred()?;

        let mut connection = self.connection.clone();
        self.runtime.spawn(async move {
            let result: Result<()> = to_js_result(connection.set(key, value).await);
            match result {
                Ok(_) => deferred.resolve(|_| Ok(())),
                Err(e) => deferred.reject(e),
            }
        });

        Ok(promise)
    }
}

#[napi(js_name = "StartSocketConnection", ts_return_type = "Promise<string>")]
pub fn start_socket_listener_external(env: Env) -> Result<JsObject> {
    let (deferred, promise) = env.create_deferred()?;

    start_socket_listener(move |result| {
        match result {
            Ok(path) => deferred.resolve(|_| Ok(path)),
            Err(e) => deferred.reject(to_js_error(e)),
        };
    });

    Ok(promise)
}
