from app.agent.turn_store import TurnStore

F1 = {"sev": "critical", "text": "first", "log_ids": ["s1:l_1"]}
F2 = {"sev": "warning", "text": "second, fixed", "log_ids": ["s1:l_2"]}

def test_resubmission_replaces_the_previous_list():
    store = TurnStore(); tid = store.create("s1")
    assert store.submit("s1", tid, [F1], [{"label": "a"}])
    assert store.submit("s1", tid, [F1, F2], [])
    turn = store.pop("s1", tid)
    assert turn.findings == [F1, F2] and turn.causal == [] and store.pop("s1", tid) is None

def test_a_turn_belongs_to_its_session():
    store = TurnStore(); tid = store.create("s1")
    assert not store.exists("s2", tid) and not store.submit("s2", tid, [F1], []) and store.pop("s2", tid) is None

def test_the_store_is_bounded_by_count_and_age():
    now = [0.0]; store = TurnStore(max_turns=2, ttl_s=60, clock=lambda: now[0])
    a, b, c = (store.create("s1") for _ in range(3))
    assert not store.exists("s1", a) and store.exists("s1", b) and len(store) == 2
    now[0] = 61.0; store.create("s1")
    assert not store.exists("s1", b) and not store.exists("s1", c) and len(store) == 1

def test_discard_session_and_clear():
    store = TurnStore(); a = store.create("s1"); store.create("s2")
    store.discard_session("s1"); assert not store.exists("s1", a) and len(store) == 1
    store.clear(); assert len(store) == 0
