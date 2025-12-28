import os
from dataclasses import fields, is_dataclass
from typing import Any, Dict

from streamrip.config import Config, DEFAULT_CONFIG_PATH, ConfigData, OutdatedConfigError, set_user_defaults


class StreamripConfigManager:
    """Loads, serializes, and updates the streamrip configuration file.

    The manager prefers the user's existing configuration and will generate a
    default config if none exists. Updates are validated against the
    dataclass-backed ConfigData model to avoid writing unexpected keys.
    """

    def __init__(self, path: str | None = None):
        self.path = path or DEFAULT_CONFIG_PATH
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        if not os.path.exists(self.path):
            set_user_defaults(self.path)

    def load(self) -> Config:
        try:
            return Config(self.path)
        except OutdatedConfigError:
            # Bring the config up to date if the shipped version changed.
            Config.update_file(self.path)
            return Config(self.path)

    def _dataclass_to_dict(self, obj: Any) -> Dict[str, Any]:
        if not is_dataclass(obj):
            return obj
        result: Dict[str, Any] = {}
        for field in fields(obj):
            if field.name in {"toml", "_modified"}:
                continue
            value = getattr(obj, field.name)
            if is_dataclass(value):
                result[field.name] = self._dataclass_to_dict(value)
            elif isinstance(value, list):
                result[field.name] = [self._dataclass_to_dict(v) for v in value]
            else:
                result[field.name] = value
        return result

    def export(self) -> Dict[str, Any]:
        with self.load() as conf:
            # Conf.file contains the persisted values, session is a copy used at runtime.
            config_data: ConfigData = conf.file
            return self._dataclass_to_dict(config_data)

    def update(self, updates: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
        """Apply updates to one or more config sections.

        Unknown sections/keys are ignored to keep the config aligned with the
        streamrip schema. Returns the updated config snapshot.
        """

        with self.load() as conf:
            for section, values in updates.items():
                if not hasattr(conf.file, section):
                    continue
                section_obj = getattr(conf.file, section)
                if not is_dataclass(section_obj):
                    continue
                for key, new_value in values.items():
                    if not hasattr(section_obj, key):
                        continue
                    setattr(section_obj, key, new_value)
                    conf.file.set_modified()
        return self.export()


__all__ = ["StreamripConfigManager"]
