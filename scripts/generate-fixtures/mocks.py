"""Offline mocks for Qdrant and Neo4j so fixture generation runs without
external services. The mocks return empty results, causing memory types to
exercise their keyword / in-memory fallback paths — which is deterministic
and exactly what the TS side compares against.
"""
from __future__ import annotations

import logging
import sys
import types
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class MockQdrantVectorStore:
    """Drop-in for QdrantVectorStore that never connects."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.url = kwargs.get("url")
        self.collection_name = kwargs.get("collection_name", "hello_agents_vectors")
        self.vector_size = kwargs.get("vector_size", 384)
        self._points: Dict[str, dict] = {}

    def add_vectors(self, vectors: List[list], metadata: List[dict], ids: List[str], **_: Any) -> bool:
        for vid, vec, meta in zip(ids, vectors, metadata):
            self._points[vid] = {"id": vid, "vector": vec, "metadata": meta}
        return True

    def search_similar(self, query_vector: list, limit: int = 5, where: Optional[dict] = None, **_: Any) -> List[dict]:
        # Empty results force upstream keyword fallback.
        return []

    def delete_memories(self, memory_ids: List[str], **_: Any) -> bool:
        for mid in memory_ids:
            self._points.pop(mid, None)
        return True

    def get_collection_stats(self, **_: Any) -> dict:
        return {"points_count": len(self._points), "vectors_count": len(self._points)}

    def collection_exists(self, **_: Any) -> bool:
        return True

    def create_collection(self, **_: Any) -> bool:
        return True

    def health_check(self, **_: Any) -> bool:
        return True

    def clear_collection(self, **_: Any) -> bool:
        self._points.clear()
        return True


class MockQdrantConnectionManager:
    """Drop-in for QdrantConnectionManager."""

    _instances: Dict[tuple, MockQdrantVectorStore] = {}

    @classmethod
    def get_instance(cls, **kwargs: Any) -> MockQdrantVectorStore:
        key = (kwargs.get("url") or "local", kwargs.get("collection_name", "default"))
        if key not in cls._instances:
            cls._instances[key] = MockQdrantVectorStore(**kwargs)
        return cls._instances[key]

    @classmethod
    def reset(cls) -> None:
        cls._instances.clear()


class MockNeo4jGraphStore:
    """Drop-in for Neo4jGraphStore that never connects."""

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self._entities: Dict[str, dict] = {}
        self._relationships: List[dict] = []

    def add_entity(self, **kwargs: Any) -> bool:
        eid = kwargs.get("entity_id")
        if eid:
            self._entities[eid] = kwargs
        return True

    def add_relationship(self, **kwargs: Any) -> bool:
        self._relationships.append(kwargs)
        return True

    def search_entities_by_name(self, **kwargs: Any) -> List[dict]:
        name_pattern = kwargs.get("name_pattern", "")
        return [e for e in self._entities.values() if name_pattern in e.get("name", "")]

    def find_related_entities(self, **kwargs: Any) -> List[dict]:
        return []

    def get_entity_relationships(self, entity_id: str, **_: Any) -> List[dict]:
        return [r for r in self._relationships if r.get("from_entity_id") == entity_id or r.get("to_entity_id") == entity_id]

    def clear_all(self, **_: Any) -> bool:
        self._entities.clear()
        self._relationships.clear()
        return True

    def get_stats(self, **_: Any) -> dict:
        return {"entity_count": len(self._entities), "relationship_count": len(self._relationships)}

    def health_check(self, **_: Any) -> bool:
        return True


def install_mocks() -> None:
    """Monkeypatch storage modules before memory types import them."""
    import bootstrap  # noqa: F401  — ensures hello_agents package entries exist

    # Build fake storage package modules.
    qdrant_mod = types.ModuleType("hello_agents.memory.storage.qdrant_store")
    qdrant_mod.QdrantVectorStore = MockQdrantVectorStore
    qdrant_mod.QdrantConnectionManager = MockQdrantConnectionManager
    sys.modules["hello_agents.memory.storage.qdrant_store"] = qdrant_mod

    neo4j_mod = types.ModuleType("hello_agents.memory.storage.neo4j_store")
    neo4j_mod.Neo4jGraphStore = MockNeo4jGraphStore
    sys.modules["hello_agents.memory.storage.neo4j_store"] = neo4j_mod

    # If storage __init__ was already imported, refresh its attributes.
    storage_mod = sys.modules.get("hello_agents.memory.storage")
    if storage_mod is not None:
        storage_mod.QdrantVectorStore = MockQdrantVectorStore
        storage_mod.QdrantConnectionManager = MockQdrantConnectionManager
        storage_mod.Neo4jGraphStore = MockNeo4jGraphStore

    logger.debug("offline storage mocks installed")
