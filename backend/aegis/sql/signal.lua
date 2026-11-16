local action = ARGV[1]
local now = redis.call('TIME')
local current = math.floor(tonumber(now[1]) / 30)
local key = KEYS[1]
if action == 'write' then
    local mode, cohort, failed, duration_bucket = ARGV[2], ARGV[3], tonumber(ARGV[4]), ARGV[5]
    local health_key = key .. ':' .. mode .. ':all:' .. current
    redis.call('HINCRBY', health_key, 'total', 1)
    if failed == 1 then redis.call('HINCRBY', health_key, 'bad', 1) end
    redis.call('EXPIRE', health_key, 900)
    if failed == 0 and duration_bucket ~= '' then
        local latency_key = key .. ':' .. mode .. ':' .. cohort .. ':' .. current
        redis.call('HINCRBY', latency_key, duration_bucket, 1)
        redis.call('EXPIRE', latency_key, 900)
    end
    return 1
elseif action == 'read' then
    local total, bad = 0, 0
    local histogram = {}
    for i=1, #ARGV - 3 do histogram[i] = 0 end
    local prefix = key .. ':' .. ARGV[2]
    for i=1,20 do
        local stamp = current - i
        local counts = redis.call('HMGET', prefix .. ':all:' .. stamp, 'total', 'bad')
        total = total + (tonumber(counts[1]) or 0)
        bad = bad + (tonumber(counts[2]) or 0)
        local bucket = redis.call('HMGET', prefix .. ':' .. ARGV[3] .. ':' .. stamp, unpack(ARGV,4))
        for j, value in ipairs(bucket) do histogram[j] = histogram[j] + (tonumber(value) or 0) end
    end
    return {total, bad, histogram}
end
