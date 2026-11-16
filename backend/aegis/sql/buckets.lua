-- All related buckets share the same Redis hash tag.
local now = redis.call('TIME')
local ms = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000)
local next_state = {}
local wait_ms = 0

for i, key in ipairs(KEYS) do
    local rate = tonumber(ARGV[3*i-2])
    local cap = tonumber(ARGV[3*i-1]) * 60000
    local charge = tonumber(ARGV[3*i]) * 60000
    if charge > cap then return {-1, 0} end
    local stored = redis.call('HMGET', key, 'credit', 'tick')
    local tick = math.max(ms, tonumber(stored[2]) or ms)
    local old_credit = tonumber(stored[1]) or math.floor(cap / 4)
    local credit = math.min(cap, old_credit + (tick - (tonumber(stored[2]) or tick)) * rate)
    wait_ms = math.max(wait_ms, math.ceil((charge - credit) / rate))
    next_state[i] = {
        credit=credit, tick=tick, charge=charge, exists=stored[1] ~= false,
        ttl=math.ceil(2 * cap / rate / 1000) + 60
    }
end

for i, key in ipairs(KEYS) do
    local state = next_state[i]
    if wait_ms == 0 or not state.exists then
        local credit = state.credit
        if wait_ms == 0 then credit = credit - state.charge end
        redis.call('HSET', key, 'credit', credit, 'tick', state.tick)
        redis.call('EXPIRE', key, state.ttl)
    end
end
if wait_ms > 0 then return {0, math.ceil(wait_ms / 1000)} end
return {1, 0}
