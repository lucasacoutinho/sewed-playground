#!/usr/bin/env python3
"""A stand-in for the BlueZ daemon, enough for Chromium to scan and find one device.

Chromium talks to `org.bluez` on the system bus. This owns that name on whatever bus
DBUS_SYSTEM_BUS_ADDRESS names (a private one the verifier starts), exposes one powered adapter,
and announces one device when a discovery starts. It prints READY once it owns the name.
"""
import os
import sys

import dbus
import dbus.mainloop.glib
import dbus.service
from gi.repository import GLib

ADAPTER = "/org/bluez/hci0"
DEVICE = ADAPTER + "/dev_AA_BB_CC_DD_EE_01"
OM = "org.freedesktop.DBus.ObjectManager"
PROPS = "org.freedesktop.DBus.Properties"

adapter_props = {
    "Address": dbus.String("00:11:22:33:44:55"),
    "AddressType": dbus.String("public"),
    "Name": dbus.String("sewed-fake"),
    "Alias": dbus.String("sewed-fake"),
    "Class": dbus.UInt32(0),
    "Powered": dbus.Boolean(True),
    "Discoverable": dbus.Boolean(False),
    "Pairable": dbus.Boolean(True),
    "PairableTimeout": dbus.UInt32(0),
    "DiscoverableTimeout": dbus.UInt32(0),
    "Discovering": dbus.Boolean(False),
    "UUIDs": dbus.Array([], signature="s"),
    "Modalias": dbus.String("usb:v1D6Bp0246d0540"),
    "Roles": dbus.Array(["central"], signature="s"),
}
device_props = {
    "Address": dbus.String("AA:BB:CC:DD:EE:01"),
    "AddressType": dbus.String("public"),
    "Name": dbus.String("Sewed Sensor"),
    "Alias": dbus.String("Sewed Sensor"),
    "Paired": dbus.Boolean(False),
    "Bonded": dbus.Boolean(False),
    "Trusted": dbus.Boolean(False),
    "Blocked": dbus.Boolean(False),
    "LegacyPairing": dbus.Boolean(False),
    "RSSI": dbus.Int16(-40),
    "Connected": dbus.Boolean(False),
    "UUIDs": dbus.Array(["0000180f-0000-1000-8000-00805f9b34fb"], signature="s"),
    "Adapter": dbus.ObjectPath(ADAPTER),
    "ServicesResolved": dbus.Boolean(False),
}


class WithProperties(dbus.service.Object):
    interfaces = {}

    @dbus.service.method(PROPS, in_signature="ss", out_signature="v")
    def Get(self, interface, name):
        return self.interfaces[interface][name]

    @dbus.service.method(PROPS, in_signature="s", out_signature="a{sv}")
    def GetAll(self, interface):
        return self.interfaces.get(interface, {})

    @dbus.service.method(PROPS, in_signature="ssv")
    def Set(self, interface, name, value):
        self.interfaces[interface][name] = value
        self.PropertiesChanged(interface, {name: value}, [])

    @dbus.service.signal(PROPS, signature="sa{sv}as")
    def PropertiesChanged(self, interface, changed, invalidated):
        pass


class Root(dbus.service.Object):
    def __init__(self, bus):
        super().__init__(bus, "/")
        self.objects = {}

    @dbus.service.method(OM, out_signature="a{oa{sa{sv}}}")
    def GetManagedObjects(self):
        return self.objects

    @dbus.service.signal(OM, signature="oa{sa{sv}}")
    def InterfacesAdded(self, path, interfaces):
        pass

    @dbus.service.signal(OM, signature="oas")
    def InterfacesRemoved(self, path, interfaces):
        pass


class Manager(dbus.service.Object):
    @dbus.service.method("org.bluez.AgentManager1", in_signature="os")
    def RegisterAgent(self, agent, capability):
        print("AGENT", agent, capability, flush=True)

    @dbus.service.method("org.bluez.AgentManager1", in_signature="o")
    def RequestDefaultAgent(self, agent):
        pass

    @dbus.service.method("org.bluez.AgentManager1", in_signature="o")
    def UnregisterAgent(self, agent):
        pass

    @dbus.service.method("org.bluez.ProfileManager1", in_signature="osa{sv}")
    def RegisterProfile(self, profile, uuid, options):
        pass

    @dbus.service.method("org.bluez.ProfileManager1", in_signature="o")
    def UnregisterProfile(self, profile):
        pass


class Adapter(WithProperties):
    def __init__(self, bus, root):
        super().__init__(bus, ADAPTER)
        self.bus = bus
        self.root = root
        self.interfaces = {"org.bluez.Adapter1": adapter_props}
        self.device = None

    def discovering(self, value):
        adapter_props["Discovering"] = dbus.Boolean(value)
        self.PropertiesChanged("org.bluez.Adapter1", {"Discovering": dbus.Boolean(value)}, [])

    @dbus.service.method("org.bluez.Adapter1", in_signature="a{sv}")
    def SetDiscoveryFilter(self, properties):
        pass

    @dbus.service.method("org.bluez.Adapter1", out_signature="as")
    def GetDiscoveryFilters(self):
        return ["UUIDs", "RSSI", "Pathloss", "Transport", "DuplicateData"]

    @dbus.service.method("org.bluez.Adapter1")
    def StartDiscovery(self):
        print("DISCOVERY start", flush=True)
        self.discovering(True)
        GLib.timeout_add(300, self.announce)

    @dbus.service.method("org.bluez.Adapter1")
    def StopDiscovery(self):
        print("DISCOVERY stop", flush=True)
        self.discovering(False)

    @dbus.service.method("org.bluez.Adapter1", in_signature="o")
    def RemoveDevice(self, device):
        pass

    def announce(self):
        if self.device is None:
            self.device = Device(self.bus, self.root)
            interfaces = {"org.bluez.Device1": device_props}
            self.root.objects[dbus.ObjectPath(DEVICE)] = interfaces
            self.root.InterfacesAdded(dbus.ObjectPath(DEVICE), interfaces)
            print("DEVICE announced", flush=True)
        return False


SERVICE = DEVICE + "/service0001"
CHARACTERISTIC = SERVICE + "/char0001"
service_props = {
    "UUID": dbus.String("0000180f-0000-1000-8000-00805f9b34fb"),
    "Device": dbus.ObjectPath(DEVICE),
    "Primary": dbus.Boolean(True),
    "Includes": dbus.Array([], signature="o"),
}
characteristic_props = {
    "UUID": dbus.String("00002a19-0000-1000-8000-00805f9b34fb"),
    "Service": dbus.ObjectPath(SERVICE),
    "Value": dbus.Array([], signature="y"),
    "Notifying": dbus.Boolean(False),
    "Flags": dbus.Array(["read"], signature="s"),
}


class NotAuthorized(dbus.DBusException):
    _dbus_error_name = "org.bluez.Error.NotAuthorized"


class AuthenticationCanceled(dbus.DBusException):
    _dbus_error_name = "org.bluez.Error.AuthenticationCanceled"


class Service(WithProperties):
    def __init__(self, bus):
        super().__init__(bus, SERVICE)
        self.interfaces = {"org.bluez.GattService1": service_props}


class Characteristic(WithProperties):
    """A battery level that can be read only once the device is paired."""

    def __init__(self, bus):
        super().__init__(bus, CHARACTERISTIC)
        self.interfaces = {"org.bluez.GattCharacteristic1": characteristic_props}

    @dbus.service.method("org.bluez.GattCharacteristic1", in_signature="a{sv}", out_signature="ay")
    def ReadValue(self, options):
        if not device_props["Paired"]:
            print("READ refused: not paired", flush=True)
            raise NotAuthorized("Pair first")
        print("READ allowed", flush=True)
        return dbus.Array([dbus.Byte(42)], signature="y")


class Device(WithProperties):
    def __init__(self, bus, root):
        super().__init__(bus, DEVICE)
        self.bus = bus
        self.root = root
        self.interfaces = {"org.bluez.Device1": device_props}
        self.gatt = None

    def changed(self, name, value):
        device_props[name] = value
        self.PropertiesChanged("org.bluez.Device1", {name: value}, [])

    @dbus.service.method("org.bluez.Device1")
    def Connect(self):
        print("CONNECT", flush=True)
        self.changed("Connected", dbus.Boolean(True))
        if self.gatt is None:
            self.gatt = (Service(self.bus), Characteristic(self.bus))
            for path, interfaces in (
                (SERVICE, {"org.bluez.GattService1": service_props}),
                (CHARACTERISTIC, {"org.bluez.GattCharacteristic1": characteristic_props}),
            ):
                self.root.objects[dbus.ObjectPath(path)] = interfaces
                self.root.InterfacesAdded(dbus.ObjectPath(path), interfaces)
        self.changed("ServicesResolved", dbus.Boolean(True))

    @dbus.service.method(
        "org.bluez.Device1", sender_keyword="sender", async_callbacks=("done", "failed")
    )
    def Pair(self, sender, done, failed):
        # A real daemon asks its registered agent to confirm; Chromium's agent lives on the
        # connection that asked to pair.
        print("PAIR requested", flush=True)
        agent = dbus.Interface(
            self.bus.get_object(sender, "/org/chromium/bluetooth_agent"), "org.bluez.Agent1"
        )

        def confirmed():
            print("PAIR confirmed", flush=True)
            self.changed("Paired", dbus.Boolean(True))
            self.changed("Bonded", dbus.Boolean(True))
            done()

        def refused(error):
            print("PAIR refused", error.get_dbus_name(), flush=True)
            failed(AuthenticationCanceled("The agent refused"))

        agent.RequestConfirmation(
            dbus.ObjectPath(DEVICE),
            dbus.UInt32(123456),
            reply_handler=confirmed,
            error_handler=refused,
            timeout=60,
        )

    @dbus.service.method("org.bluez.Device1")
    def Disconnect(self):
        device_props["Connected"] = dbus.Boolean(False)
        self.PropertiesChanged("org.bluez.Device1", {"Connected": dbus.Boolean(False)}, [])

    @dbus.service.method("org.bluez.Device1")
    def CancelPairing(self):
        pass


def main():
    dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
    bus = dbus.bus.BusConnection(os.environ["DBUS_SYSTEM_BUS_ADDRESS"])
    name = dbus.service.BusName("org.bluez", bus)
    root = Root(bus)
    Manager(bus, "/org/bluez")
    adapter = Adapter(bus, root)
    root.objects[dbus.ObjectPath("/org/bluez")] = {
        "org.bluez.AgentManager1": {},
        "org.bluez.ProfileManager1": {},
    }
    root.objects[dbus.ObjectPath(ADAPTER)] = adapter.interfaces
    print("READY", flush=True)
    assert name is not None
    GLib.MainLoop().run()


if __name__ == "__main__":
    sys.exit(main())
