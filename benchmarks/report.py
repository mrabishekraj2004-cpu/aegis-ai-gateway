"""Summarize the load runner's final Locust histograms and gateway metrics."""

import argparse
import json
from collections import Counter
from math import ceil
from pathlib import Path


def percentile(times: Counter[int], share: float) -> int:
    rank = ceil(times.total() * share)
    for millis, observations in sorted(times.items()):
        rank -= observations
        if rank <= 0:
            return millis
    raise ValueError("The requested profile contains no response measurements.")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path)
    args = parser.parse_args()
    run = json.loads((args.run / "run.json").read_text())
    for profile in run["profiles"]:
        users = profile["users"]
        rows = json.loads((args.run / f"users-{users}-final.json").read_text())
        requests = sum(row["num_requests"] for row in rows)
        failures = sum(row["num_failures"] for row in rows)
        observed = max(row["last_request_timestamp"] for row in rows) - min(
            row["start_time"] for row in rows
        )
        times: Counter[int] = Counter()
        for row in rows:
            times.update(
                {int(ms): count for ms, count in row["response_times"].items()}
            )
        print(
            f"{users} users · {requests} requests · {failures} failures · {requests / observed:.2f} requests/s · "
            f"p50 {percentile(times, 0.50)} ms · p95 {percentile(times, 0.95)} ms · p99 {percentile(times, 0.99)} ms"
        )
        values = profile["metrics"]
        for mode in ("json", "sse"):
            score = f"{mode}:aegis_routing_evaluation_seconds"
            admit = f"{mode}:aegis_gateway_admission_seconds"
            if values.get(score + "_count", 0):
                scoring_us = (
                    1_000_000 * values[score + "_sum"] / values[score + "_count"]
                )
                admission_ms = 1000 * values[admit + "_sum"] / values[admit + "_count"]
                print(
                    f"  {mode} · scoring {scoring_us:.2f} µs mean · admission {admission_ms:.2f} ms mean"
                )


if __name__ == "__main__":
    main()
