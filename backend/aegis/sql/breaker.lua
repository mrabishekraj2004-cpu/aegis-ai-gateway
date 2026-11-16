local key = KEYS[1]
local action, token, generation = ARGV[1], ARGV[2], ARGV[3]
if action ~= 'result' and redis.call('EXISTS', KEYS[2]) == 1 then
    return {0, '', 'cooldown'}
end
local now = redis.call('TIME')
local sec = tonumber(now[1])
local phase = redis.call('HGET', key, 'phase')
local wait = tonumber(redis.call('HGET', key, 'wait')) or 10
local until_sec = tonumber(redis.call('HGET', key, 'until')) or 0

local function change(next_phase, new_epoch, next_until, next_wait, owner)
    redis.call('HSET', key, 'phase', next_phase, 'generation', new_epoch,
               'until', next_until, 'wait', next_wait, 'owner', owner)
    redis.call('EXPIRE', key, 86400)
end

if not phase then
    -- A late result must not initialize an erased state or bless a new primary epoch.
    if action == 'result' then return {0, '', 'unknown'} end
    local cold = tonumber(ARGV[4])
    phase = (cold > 0 and 'open' or 'closed')
    until_sec = sec + cold
    change(phase, token, until_sec, 10, '')
end
local epoch = redis.call('HGET', key, 'generation')

if phase == 'half_open' and sec >= until_sec then
    phase, epoch, until_sec = 'open', token, sec + wait
    change(phase, epoch, until_sec, wait, '')
end

if action == 'peek' then
    if phase == 'closed' then return {1, epoch, phase} end
    if phase == 'open' and sec >= until_sec then return {2, epoch, 'probe_ready'} end
    return {0, epoch, phase}
end

if action == 'grant' then
    if phase == 'closed' then
        redis.call('EXPIRE', key, 86400)
        return {1, epoch, phase}
    end
    if phase == 'open' and sec >= until_sec then
        change('half_open', token, sec + tonumber(ARGV[5]), wait, token)
        return {2, token, 'half_open'}
    end
    return {0, epoch, phase}
end

if generation ~= epoch then return {0, epoch, phase} end
local result = ARGV[6]
if phase == 'half_open' and redis.call('HGET', key, 'owner') == token then
    if result == 'good' then
        for i = 0,29 do redis.call('HDEL', key, 'b' .. i) end
        change('closed', ARGV[7], 0, 10, '')
        return {1, ARGV[7], 'closed'}
    end
    if result == 'bad' then wait = math.min(60, 2 * wait) end
    change('open', ARGV[7], sec + wait, wait, '')
    return {1, ARGV[7], 'open'}
end

if phase ~= 'closed' or result == 'neutral' then return {0, epoch, phase} end
local bucket_key = 'b' .. (sec % 30)
local item = redis.call('HGET', key, bucket_key) or ''
local stamp, count, failures = string.match(item, '^(%d+):(%d+):(%d+)$')
local total = tonumber(stamp) == sec and tonumber(count) or 0
local bad = tonumber(stamp) == sec and tonumber(failures) or 0
bad = bad + (result == 'bad' and 1 or 0)
redis.call('HSET', key, bucket_key, sec .. ':' .. (total + 1) .. ':' .. bad)
redis.call('EXPIRE', key, 86400)
local window_total, window_bad = 0, 0
for i=0,29 do
    local entry = redis.call('HGET', key, 'b' .. i) or ''
    local tick, n, b = string.match(entry, '^(%d+):(%d+):(%d+)$')
    tick = tonumber(tick)
    if tick and tick > sec - 30 and tick <= sec then
        window_total = window_total + tonumber(n)
        window_bad = window_bad + tonumber(b)
    end
end
if window_total >= 10 and window_bad * 2 >= window_total then
    change('open', ARGV[7], sec + 10, 10, '')
    return {1, ARGV[7], 'open'}
end
return {1, epoch, 'closed'}
