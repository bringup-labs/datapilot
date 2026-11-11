import copy
from app.agent.composer import _filter_uncited
from app.agent.grounding import check_findings

SID = "sess-1"
CASES = [
    {"sev": "critical", "text": "cited, exists", "log_ids": [f"{SID}:l_5"]},
    {"sev": "warning", "text": "cited, missing", "log_ids": [f"{SID}:l_999"]},
    {"sev": "critical", "text": "uncited critical", "log_ids": []},
    {"sev": "warning", "text": "uncited warning", "log_ids": []},
    {"sev": "info", "text": "uncited info", "log_ids": []},
    {"sev": "warning", "text": "one of two exists", "log_ids": [f"{SID}:l_999", f"{SID}:l_8"]},
]

def test_check_findings_keeps_and_drops_like_filter_uncited(existing_logs):
    existing_logs([f"{SID}:l_5", f"{SID}:l_8"])
    result = check_findings(SID, copy.deepcopy(CASES), [])
    kept, _ = _filter_uncited(copy.deepcopy(CASES), {f"{SID}:l_5", f"{SID}:l_8"})
    assert [f["text"] for f in result["findings"]] == [f["text"] for f in kept] == ["cited, exists", "uncited info", "one of two exists"]
    assert [r["index"] for r in result["rejected"]] == [1, 2, 3]

def test_each_rejection_says_why(existing_logs):
    existing_logs([f"{SID}:l_5"])
    reasons = {r["index"]: r["reason"] for r in check_findings(SID, copy.deepcopy(CASES), [])["rejected"]}
    assert reasons[1] == "None of its log IDs exist in this bag: sess-1:l_999."
    assert reasons[2] == "Critical and warning findings need at least one log ID from a tool result."

def test_bare_log_ids_are_scoped_to_the_session(existing_logs):
    existing_logs([f"{SID}:l_5"])
    result = check_findings(SID, [{"sev": "critical", "text": "x", "log_ids": ["l_5"]}], [])
    assert result["findings"][0]["log_ids"] == [f"{SID}:l_5"]

def test_causal_steps_follow_the_same_rule(existing_logs):
    existing_logs([f"{SID}:l_5"])
    steps = [{"label": "a", "log_id": f"{SID}:l_5"}, {"label": "b", "log_id": "l_999"}, {"label": "c"}]
    result = check_findings(SID, [], steps)
    assert [s["label"] for s in result["causal"]] == ["a", "c"]
    assert result["causal_rejected"] == [{"index": 1, "label": "b", "reason": "Log ID sess-1:l_999 doesn't exist in this bag."}]


from app.agent.grounding import find_unknown_log_ids


def test_find_unknown_log_ids_flags_other_bags_and_missing_ids(existing_logs):
    existing_logs(["sess-1:l_5", "sess-1:l_8"])
    text = "The planner aborted (l_8) after a dropout (sess-1:l_5). See also l_999 and other-bag:l_5."
    assert find_unknown_log_ids("sess-1", text) == ["l_999", "other-bag:l_5"]


def test_find_unknown_log_ids_checks_both_ends_of_a_range(existing_logs):
    existing_logs(["sess-1:l_12"])
    assert find_unknown_log_ids("sess-1", "The planner retried (l_12-l_15).") == ["l_15"]
    assert find_unknown_log_ids("sess-1", "Retries in l_12-l_15, see other-bag:l_5.") == ["l_15", "other-bag:l_5"]


def test_find_unknown_log_ids_skips_neo4j_without_mentions(mock_neo4j):
    assert find_unknown_log_ids("sess-1", "No log lines mentioned.") == []
    mock_neo4j.run_query.assert_not_called()
